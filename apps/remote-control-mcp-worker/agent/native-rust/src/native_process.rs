//! Nonproduction managed process execution behind the existing signed WSS lease.
//! Every possible side effect must be admitted in the *same* SQLite v1 store
//! as file mutations. An Unknown receipt is never dispatched a second time.
#![cfg(any(target_os = "linux", target_os = "macos", windows))]

#[cfg(target_os = "macos")]
use crate::darwin_managed::{
    valid_command_text, CleanupState, DarwinManagedSessions as ManagedSessions, InputOutcome,
    SessionCapacityReached, SessionSnapshot, SessionState,
};
#[cfg(target_os = "macos")]
use crate::darwin_output::{MAX_OUTPUT_BYTES, MAX_PAGE_BYTES};
#[cfg(target_os = "linux")]
use crate::linux_command::valid_command_text;
#[cfg(target_os = "linux")]
use crate::linux_managed::{
    InputOutcome, LinuxManagedSessions as ManagedSessions, SessionCapacityReached, SessionSnapshot,
    SessionState,
};
#[cfg(target_os = "linux")]
use crate::linux_output::{MAX_OUTPUT_BYTES, MAX_PAGE_BYTES};
#[cfg(target_os = "linux")]
use crate::linux_supervisor::CleanupState;
use crate::native_read::integer_in_range;
use crate::receipts::{Admission, Receipt, ReceiptError, ReceiptStore};
#[cfg(windows)]
use crate::windows_job::{valid_command_text, JobCleanup as CleanupState};
#[cfg(windows)]
use crate::windows_managed::{
    InputOutcome, SessionCapacityReached, SessionSnapshot, SessionState,
    WindowsManagedSessions as ManagedSessions,
};
#[cfg(windows)]
use crate::windows_output::{MAX_OUTPUT_BYTES, MAX_PAGE_BYTES};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

const MAX_WIRE_BYTES: usize = 65_536;
const DEFAULT_PAGE_BYTES: usize = 16 * 1024;
const MAX_START_WAIT: Duration = Duration::from_millis(1_500);
const STOP_WAIT: Duration = Duration::from_millis(1_500);

fn confirmed_prelaunch_capacity(error: &std::io::Error) -> bool {
    error
        .get_ref()
        .is_some_and(|source| source.is::<SessionCapacityReached>())
}

#[cfg(test)]
mod capacity_tests {
    use super::*;
    use std::io;

    #[test]
    fn raw_wouldblock_after_os_launch_is_never_treated_as_no_effect() {
        assert!(confirmed_prelaunch_capacity(&io::Error::new(
            io::ErrorKind::WouldBlock,
            SessionCapacityReached,
        )));
        assert!(!confirmed_prelaunch_capacity(&io::Error::new(
            io::ErrorKind::WouldBlock,
            "thread spawn failed after launching the command",
        )));
        assert!(!confirmed_prelaunch_capacity(&io::Error::from(
            io::ErrorKind::WouldBlock,
        )));
    }
}

pub(crate) fn valid_session_id(id: &str) -> bool {
    if id.len() != 36 {
        return false;
    }
    id.bytes().enumerate().all(|(i, byte)| match i {
        8 | 13 | 18 | 23 => byte == b'-',
        14 => byte == b'4',
        19 => b"89ab".contains(&byte),
        _ => byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte),
    })
}

#[derive(Debug, Clone)]
pub enum ProcessRead {
    List,
    Output {
        session_id: String,
        offset: usize,
        length: usize,
    },
    Failed,
}

pub fn parse_process_read(tool: &str, value: &Value) -> Option<ProcessRead> {
    if tool == "list_sessions" {
        return Some(
            if value.as_object().is_some_and(serde_json::Map::is_empty) {
                ProcessRead::List
            } else {
                ProcessRead::Failed
            },
        );
    }
    if tool != "read_process_output" {
        return None;
    }
    let Some(args) = value.as_object() else {
        return Some(ProcessRead::Failed);
    };
    if args
        .keys()
        .any(|key| !matches!(key.as_str(), "session_id" | "offset" | "length"))
    {
        return Some(ProcessRead::Failed);
    }
    let id = args.get("session_id").and_then(Value::as_str);
    let offset = args
        .get("offset")
        .map_or(Some(0), |v| integer_in_range(v, 0, MAX_OUTPUT_BYTES as i64));
    let length = args
        .get("length")
        .map_or(Some(DEFAULT_PAGE_BYTES as i64), |v| {
            integer_in_range(v, 1, MAX_PAGE_BYTES as i64)
        });
    Some(match (id, offset, length) {
        (Some(id), Some(offset), Some(length)) if valid_session_id(id) => ProcessRead::Output {
            session_id: id.to_owned(),
            offset: offset as usize,
            length: length as usize,
        },
        _ => ProcessRead::Failed,
    })
}

#[derive(Debug, Clone)]
pub enum ProcessMutation {
    Start { command: String, timeout_ms: u64 },
    Input { session_id: String, input: String },
    Terminate { session_id: String },
}

impl ProcessMutation {
    fn normalized(&self) -> Value {
        match self {
            // Node's ReceiptStore hashes *parseStartProcess output*, with a
            // camelCase timeoutMs, not the original WSS timeout_ms field.
            Self::Start {
                command,
                timeout_ms,
            } => json!({"command": command, "timeoutMs": timeout_ms}),
            Self::Input { session_id, input } => json!({"session_id": session_id, "input": input}),
            Self::Terminate { session_id } => json!({"session_id": session_id}),
        }
    }
}

pub fn parse_process_mutation(tool: &str, value: &Value) -> Option<ProcessMutation> {
    let args = value.as_object()?;
    match tool {
        "start_process" => {
            if args
                .keys()
                .any(|key| !matches!(key.as_str(), "command" | "timeout_ms"))
            {
                return None;
            }
            let command = args.get("command")?.as_str()?;
            if !valid_command_text(command) {
                return None;
            }
            let timeout = args
                .get("timeout_ms")
                .map_or(Some(1_000), |v| integer_in_range(v, 0, 30_000))?;
            Some(ProcessMutation::Start {
                command: command.to_owned(),
                timeout_ms: timeout as u64,
            })
        }
        "interact_with_process" => {
            if args
                .keys()
                .any(|key| !matches!(key.as_str(), "session_id" | "input"))
            {
                return None;
            }
            let session_id = args.get("session_id")?.as_str()?;
            let input = args.get("input")?.as_str()?;
            if !valid_session_id(session_id)
                || input.is_empty()
                || input.len() > 8_192
                || input.contains('\0')
            {
                return None;
            }
            Some(ProcessMutation::Input {
                session_id: session_id.to_owned(),
                input: input.to_owned(),
            })
        }
        "force_terminate" => {
            if args.len() != 1 {
                return None;
            }
            let session_id = args.get("session_id")?.as_str()?;
            valid_session_id(session_id).then(|| ProcessMutation::Terminate {
                session_id: session_id.to_owned(),
            })
        }
        _ => None,
    }
}

fn state_name(state: SessionState) -> &'static str {
    match state {
        SessionState::Running => "running",
        SessionState::Completed => "completed",
        SessionState::Failed => "failed",
        SessionState::Unknown => "unknown",
    }
}

fn session_json(snapshot: &SessionSnapshot) -> Value {
    let mut value = json!({
        "session_id": snapshot.session_id,
        "started_at": snapshot.started_at,
        "last_observed_at": snapshot.last_observed_at,
        "state": state_name(snapshot.state),
        "exit_code": snapshot.exit_code
    });
    if snapshot.deadline_exceeded {
        value["termination_reason"] = json!("deadline_exceeded");
    }
    value
}

pub fn execute_process_read(
    registry: &ManagedSessions,
    request_id: &str,
    read: &ProcessRead,
) -> String {
    let response = |text: String| {
        json!({"kind":"read_result", "request_id":request_id,
            "status":"completed", "text":text})
        .to_string()
    };
    match read {
        ProcessRead::List => {
            let text =
                json!(registry.list().iter().map(session_json).collect::<Vec<_>>()).to_string();
            let wire = response(text);
            if wire.len() <= MAX_WIRE_BYTES {
                return wire;
            }
        }
        ProcessRead::Output {
            session_id,
            offset,
            length,
        } => {
            // The outer WSS frame double-escapes output embedded in "text".
            // Accept Node's 64 KiB requested length, but reduce the returned
            // page until the actual encoded frame fits the transport limit.
            let mut page_length = *length;
            while page_length > 0 {
                let Some(read) = registry
                    .read_output(session_id, *offset, page_length)
                    .ok()
                    .flatten()
                else {
                    return json!({"kind":"read_result","request_id":request_id,
                        "status":"failed"})
                    .to_string();
                };
                let mut output = session_json(&read.session);
                output["offset"] = json!(read.page.offset);
                output["next_offset"] = json!(read.page.next_offset);
                output["output"] = json!(read.page.output);
                output["eof"] = json!(read.page.eof);
                output["truncated"] = json!(read.page.truncated);
                let wire = response(output.to_string());
                if wire.len() <= MAX_WIRE_BYTES {
                    return wire;
                }
                if page_length == 1 {
                    break;
                }
                page_length = (page_length / 2).max(1);
            }
        }
        ProcessRead::Failed => {
            return json!({"kind":"read_result","request_id":request_id,
                "status":"failed"})
            .to_string();
        }
    }
    json!({"kind":"read_result", "request_id":request_id,
        "status":"failed", "error":"result_too_large"})
    .to_string()
}

pub struct ProcessOutcome {
    pub state: &'static str,
    pub receipt: Option<Receipt>,
    pub session_id: Option<String>,
}

pub struct NativeProcessEngine {
    pub sessions: Arc<ManagedSessions>,
    starts: HashMap<String, String>,
}

impl NativeProcessEngine {
    pub fn new(sessions: Arc<ManagedSessions>) -> Self {
        Self {
            sessions,
            starts: HashMap::new(),
        }
    }

    /// Caller must serialize this with request execution and reconcile first.
    /// A running or uncertain owned OS process is never idle for cutover.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    pub fn is_quiescent_for_upgrade(&self) -> bool {
        self.starts.is_empty()
            && self.sessions.list().iter().all(|session| {
                matches!(
                    session.state,
                    SessionState::Completed | SessionState::Failed
                ) && session.cleanup == Some(CleanupState::Confirmed)
            })
    }

    /// Process exit reconciliation runs even when no Owner request arrives.
    /// A startup receipt can only become completed after OS-owned process
    /// cleanup confirmation, never just stdout/stderr EOF.
    pub fn reconcile(&mut self, receipts: &mut ReceiptStore) -> Result<(), ReceiptError> {
        let starts: Vec<_> = self
            .starts
            .iter()
            .map(|(op, session)| (op.clone(), session.clone()))
            .collect();
        for (op, session) in starts {
            let (state, summary) = match self.sessions.get(&session) {
                Some(snapshot) if snapshot.state == SessionState::Running => continue,
                Some(snapshot) if snapshot.state == SessionState::Completed => {
                    ("completed", "Development command session ended.")
                }
                Some(snapshot) if snapshot.state == SessionState::Failed => {
                    ("failed", "Development command session failed.")
                }
                _ => ("unknown", "Development command result is uncertain."),
            };
            receipts.update(&op, state, summary, Some(&session), false)?;
            self.starts.remove(&op);
        }
        Ok(())
    }

    pub fn execute(
        &mut self,
        receipts: &mut ReceiptStore,
        operation_id: &str,
        tool: &str,
        arguments: &Value,
        lease_active: impl Fn() -> bool,
    ) -> Result<ProcessOutcome, ReceiptError> {
        let mutation =
            parse_process_mutation(tool, arguments).ok_or(ReceiptError::InvalidOperation)?;
        self.reconcile(receipts)?;
        // An already revoked lease must not even admit a new operation.
        if !lease_active() {
            return Ok(ProcessOutcome {
                state: "unavailable",
                receipt: None,
                session_id: None,
            });
        }
        // Node does not consume a receipt for a first attempt against a missing
        // session. Existing operation IDs still resolve by their stored digest.
        match &mutation {
            ProcessMutation::Input { session_id, .. }
            | ProcessMutation::Terminate { session_id }
                if receipts.get(operation_id)?.is_none()
                    && self.sessions.get(session_id).is_none() =>
            {
                return Ok(ProcessOutcome {
                    state: "not_found",
                    receipt: None,
                    session_id: None,
                });
            }
            _ => {}
        }
        let admission = receipts.admit(operation_id, tool, &mutation.normalized())?;
        match admission {
            Admission::Conflict(receipt) => {
                return Ok(ProcessOutcome {
                    state: "conflict",
                    receipt: Some(receipt),
                    session_id: None,
                })
            }
            Admission::Full => {
                return Ok(ProcessOutcome {
                    state: "unavailable",
                    receipt: None,
                    session_id: None,
                })
            }
            Admission::Same(receipt) => {
                let mut state = match receipt.state.as_str() {
                    "completed" => "completed",
                    "failed" => "failed",
                    "running" if self.starts.contains_key(operation_id) => "running",
                    _ => "unknown",
                };
                let receipt = if state == "unknown" && receipt.state != "unknown" {
                    receipts.update(
                        operation_id,
                        "unknown",
                        "Effect cannot be established.",
                        None,
                        false,
                    )?
                } else {
                    receipt
                };
                // Never execute a Same/Unknown operation again.
                if state == "running" && !self.starts.contains_key(operation_id) {
                    state = "unknown";
                }
                return Ok(ProcessOutcome {
                    state,
                    session_id: receipt.session_id.clone(),
                    receipt: Some(receipt),
                });
            }
            Admission::New(_) => {}
        }

        receipts.update(
            operation_id,
            "running",
            "Session action is in progress.",
            None,
            false,
        )?;
        if !lease_active() {
            let receipt = receipts.update(
                operation_id,
                "failed",
                "Lease revoked before any effect.",
                None,
                true,
            )?;
            return Ok(ProcessOutcome {
                state: "failed",
                receipt: Some(receipt),
                session_id: None,
            });
        }
        let (state, summary, session_id, known_no_effect) = match mutation {
            ProcessMutation::Start {
                command,
                timeout_ms,
            } => {
                // Include the synchronous C-supervisor handshake in the reply
                // budget; never add another full wait after slow startup.
                let deadline =
                    Instant::now() + Duration::from_millis(timeout_ms).min(MAX_START_WAIT);
                match self.sessions.start(&command) {
                    Ok(started) => {
                        let sid = started.session_id;
                        self.starts.insert(operation_id.to_owned(), sid.clone());
                        // Persist the OS session association before any waiting.
                        receipts.update(
                            operation_id,
                            "running",
                            "Development command session recorded.",
                            Some(&sid),
                            false,
                        )?;
                        while Instant::now() < deadline {
                            if self
                                .sessions
                                .get(&sid)
                                .is_some_and(|s| s.state != SessionState::Running)
                            {
                                break;
                            }
                            thread::sleep(Duration::from_millis(25));
                        }
                        self.reconcile(receipts)?;
                        let receipt = receipts.get(operation_id)?.ok_or(ReceiptError::NotFound)?;
                        let state = match receipt.state.as_str() {
                            "completed" => "completed",
                            "failed" => "failed",
                            "unknown" => "unknown",
                            _ => "running",
                        };
                        return Ok(ProcessOutcome {
                            state,
                            session_id: Some(sid),
                            receipt: Some(receipt),
                        });
                    }
                    // Handshake errors can occur *after* native launch. Even an
                    // Interrupted error may be a concurrent revoke.
                    Err(error) if confirmed_prelaunch_capacity(&error) => (
                        "failed",
                        "Development command start failed: session_capacity.",
                        None,
                        true,
                    ),
                    Err(_) => (
                        "unknown",
                        "Development command start is uncertain.",
                        None,
                        false,
                    ),
                }
            }
            ProcessMutation::Input { session_id, input } => {
                match self.sessions.write_input(&session_id, &input) {
                    InputOutcome::Completed => (
                        "completed",
                        "Session action completed.",
                        Some(session_id),
                        false,
                    ),
                    InputOutcome::Failed | InputOutcome::NotFound => (
                        "failed",
                        "Session action had no effect.",
                        Some(session_id),
                        true,
                    ),
                    InputOutcome::Unknown => (
                        "unknown",
                        "Session input outcome is uncertain.",
                        Some(session_id),
                        false,
                    ),
                }
            }
            ProcessMutation::Terminate { session_id } => {
                if self.sessions.get(&session_id).is_none() {
                    (
                        "failed",
                        "Managed session not found.",
                        Some(session_id),
                        true,
                    )
                } else {
                    self.sessions.request_stop(&session_id);
                    let deadline = Instant::now() + STOP_WAIT;
                    let state = loop {
                        match self.sessions.get(&session_id) {
                            Some(snapshot)
                                if matches!(
                                    snapshot.state,
                                    SessionState::Completed | SessionState::Failed
                                ) && snapshot.cleanup == Some(CleanupState::Confirmed) =>
                            {
                                break "completed"
                            }
                            Some(snapshot) if snapshot.state == SessionState::Unknown => {
                                break "unknown"
                            }
                            None => break "unknown",
                            _ if Instant::now() >= deadline => break "unknown",
                            _ => thread::sleep(Duration::from_millis(25)),
                        }
                    };
                    if state == "completed" {
                        (
                            state,
                            "Managed session stop confirmed.",
                            Some(session_id),
                            false,
                        )
                    } else {
                        (
                            state,
                            "Managed session cleanup is uncertain.",
                            Some(session_id),
                            false,
                        )
                    }
                }
            }
        };
        let receipt = receipts.update(
            operation_id,
            state,
            summary,
            session_id.as_deref(),
            known_no_effect,
        )?;
        Ok(ProcessOutcome {
            state,
            session_id,
            receipt: Some(receipt),
        })
    }
}
