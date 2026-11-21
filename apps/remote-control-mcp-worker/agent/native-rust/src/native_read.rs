//! Nonproduction read-only file execution against the existing rc-v2 read_result wire format.
//! Only an already authenticated, leased WSS session may call this module.
//! Search, process inspection and every mutation remain deliberately unavailable.
use serde_json::{json, Map, Value};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

const MAX_SCAN_BYTES: usize = 1_048_576;
const MAX_RESULT_CHARS: usize = 200_000;
const MAX_WIRE_BYTES: usize = 65_536;
const CHUNK_BYTES: usize = 65_536;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadFrameError {
    Policy,
}

#[derive(Debug)]
pub struct ReadOptions {
    path: String,
    offset: i64,
    length: usize,
}

#[derive(Debug)]
pub enum ReadCommand {
    File {
        request_id: String,
        options: ReadOptions,
    },
    Browse {
        request_id: String,
        command: crate::native_browse::BrowseCommand,
    },
    Failed {
        request_id: String,
    },
}

fn valid_request_id(value: &str) -> bool {
    if value.len() != 36 {
        return false;
    }
    value.bytes().enumerate().all(|(i, b)| {
        if [8, 13, 18, 23].contains(&i) {
            b == b'-'
        } else {
            b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
        }
    })
}

pub(crate) fn permitted_path(path: &str) -> bool {
    if path.is_empty() || path.encode_utf16().count() > 4096 || path.contains('\0') {
        return false;
    }
    #[cfg(windows)]
    {
        let bytes = path.as_bytes();
        if bytes.len() < 3
            || !bytes[0].is_ascii_alphabetic()
            || bytes[1] != b':'
            || !matches!(bytes[2], b'/' | b'\\')
            || path[2..].contains(':')
            || path.starts_with("//")
            || path.starts_with("\\\\")
        {
            return false;
        }
        !path[3..].split(['/', '\\']).any(|component| {
            let stem = component
                .split('.')
                .next()
                .unwrap_or("")
                .to_ascii_lowercase();
            matches!(
                stem.as_str(),
                "con"
                    | "prn"
                    | "aux"
                    | "nul"
                    | "com1"
                    | "com2"
                    | "com3"
                    | "com4"
                    | "com5"
                    | "com6"
                    | "com7"
                    | "com8"
                    | "com9"
                    | "lpt1"
                    | "lpt2"
                    | "lpt3"
                    | "lpt4"
                    | "lpt5"
                    | "lpt6"
                    | "lpt7"
                    | "lpt8"
                    | "lpt9"
            )
        })
    }
    #[cfg(not(windows))]
    {
        if path.starts_with("//") {
            return false;
        }
        // Match Node's scheme rejection /^[a-zA-Z][a-zA-Z0-9+.-]*:/.
        if let Some((scheme, _)) = path.split_once(':') {
            if scheme
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_alphabetic)
                && scheme
                    .bytes()
                    .skip(1)
                    .all(|b| b.is_ascii_alphanumeric() || b"+.-".contains(&b))
            {
                return false;
            }
        }
        true
    }
}

pub(crate) fn integer_in_range(value: &Value, min: i64, max: i64) -> Option<i64> {
    // JSON 1.0 and -0.0 are integers to Node's Number.isInteger.
    let number = value.as_f64()?;
    (number.is_finite() && number.fract() == 0.0 && number >= min as f64 && number <= max as f64)
        .then_some(number as i64)
}

fn parse_options(value: &Value) -> Option<ReadOptions> {
    let object = value.as_object()?;
    if object
        .keys()
        .any(|key| !matches!(key.as_str(), "path" | "offset" | "length" | "isUrl"))
    {
        return None;
    }
    if object
        .get("isUrl")
        .is_some_and(|v| v != &Value::Bool(false))
    {
        return None;
    }
    let path = object.get("path")?.as_str()?;
    if !permitted_path(path) {
        return None;
    }
    let offset = match object.get("offset") {
        Some(value) => integer_in_range(value, -100_000, 1_000_000)?,
        None => 0,
    };
    let length = match object.get("length") {
        Some(value) => integer_in_range(value, 1, 1000)? as usize,
        None => 1000,
    };
    Some(ReadOptions {
        path: path.to_owned(),
        offset,
        length,
    })
}

fn read_tool(tool: &str) -> bool {
    // The remainder of the Node read surface is still deliberately unavailable.
    matches!(
        tool,
        "read_file" | "read_multiple_files" | "list_directory" | "get_file_info"
    )
}

/// Parse the complete authenticated WSS read envelope before any file is touched.
/// Unknown tools are policy errors; invalid arguments of known read tools fail closed.
pub fn parse_read_frame(frame: &str) -> Result<ReadCommand, ReadFrameError> {
    if frame.len() > MAX_WIRE_BYTES {
        return Err(ReadFrameError::Policy);
    }
    let value: Value = serde_json::from_str(frame).map_err(|_| ReadFrameError::Policy)?;
    let object: &Map<String, Value> = value.as_object().ok_or(ReadFrameError::Policy)?;
    if object.len() != 4 || object.get("kind").and_then(Value::as_str) != Some("read") {
        return Err(ReadFrameError::Policy);
    }
    let request_id = object
        .get("request_id")
        .and_then(Value::as_str)
        .ok_or(ReadFrameError::Policy)?;
    if !valid_request_id(request_id) {
        return Err(ReadFrameError::Policy);
    }
    let tool = object
        .get("tool")
        .and_then(Value::as_str)
        .ok_or(ReadFrameError::Policy)?;
    if !read_tool(tool) {
        return Err(ReadFrameError::Policy);
    }
    let args = object.get("arguments").ok_or(ReadFrameError::Policy)?;
    if tool == "read_file" {
        if let Some(options) = parse_options(args) {
            return Ok(ReadCommand::File {
                request_id: request_id.to_owned(),
                options,
            });
        }
    } else if let Some(command) = crate::native_browse::parse_browse_options(tool, args) {
        return Ok(ReadCommand::Browse {
            request_id: request_id.to_owned(),
            command,
        });
    }
    Ok(ReadCommand::Failed {
        request_id: request_id.to_owned(),
    })
}

fn normalized_lines(bytes: &[u8]) -> Vec<String> {
    let text = String::from_utf8_lossy(bytes)
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let mut lines: Vec<String> = text.split('\n').map(str::to_owned).collect();
    if text.ends_with('\n') {
        lines.pop();
    }
    lines
}

fn open_regular(path: &str) -> Result<File, ()> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NONBLOCK);
    let file = options.open(Path::new(path)).map_err(|_| ())?;
    if !file.metadata().map_err(|_| ())?.is_file() {
        return Err(());
    }
    Ok(file)
}

fn read_forward(mut file: File, offset: usize, length: usize) -> Result<String, ()> {
    let mut bytes = Vec::new();
    let mut eof = false;
    loop {
        // Incremental scan: a small early window must not scan a huge file.
        let decoded = String::from_utf8_lossy(&bytes)
            .replace("\r\n", "\n")
            .replace('\r', "\n");
        let complete = decoded.matches('\n').count();
        if complete >= offset.saturating_add(length) {
            break;
        }
        // Node's streaming decoder refuses a >200K UTF-16-char pending
        // line even when the requested offset would otherwise skip it.
        if decoded
            .rsplit('\n')
            .next()
            .unwrap_or("")
            .encode_utf16()
            .count()
            > MAX_RESULT_CHARS
        {
            return Err(());
        }
        if eof {
            break;
        }
        let available = MAX_SCAN_BYTES.saturating_sub(bytes.len());
        if available == 0 {
            return Err(());
        }
        let mut buffer = vec![0u8; available.min(CHUNK_BYTES)];
        let n = file.read(&mut buffer).map_err(|_| ())?;
        if n == 0 {
            eof = true;
        } else {
            bytes.extend_from_slice(&buffer[..n]);
        }
    }
    let lines = normalized_lines(&bytes);
    let text = lines
        .into_iter()
        .skip(offset)
        .take(length)
        .collect::<Vec<_>>()
        .join("\n");
    if text.encode_utf16().count() > MAX_RESULT_CHARS {
        return Err(());
    }
    Ok(text)
}

fn read_from_end(mut file: File, offset: usize, length: usize) -> Result<String, ()> {
    let size = file.metadata().map_err(|_| ())?.len();
    if size == 0 {
        return Ok(String::new());
    }
    let remaining = usize::try_from(size.min(MAX_SCAN_BYTES as u64)).map_err(|_| ())?;
    let start = size - remaining as u64;
    file.seek(SeekFrom::Start(start)).map_err(|_| ())?;
    let mut bytes = vec![0; remaining];
    file.read_exact(&mut bytes).map_err(|_| ())?;
    let mut lines = normalized_lines(&bytes);
    if start > 0 {
        // Truncated first line must never become a fabricated valid result.
        let first_break = bytes
            .iter()
            .position(|&b| b == b'\n' || b == b'\r')
            .ok_or(())?;
        let prefix = String::from_utf8_lossy(&bytes[..first_break]);
        if !prefix.is_empty() || bytes.first() == Some(&b'\n') || bytes.first() == Some(&b'\r') {
            lines.remove(0);
        }
    }
    if start > 0 && lines.len() < offset {
        return Err(());
    }
    let from = lines.len().saturating_sub(offset);
    let text = lines
        .into_iter()
        .skip(from)
        .take(length)
        .collect::<Vec<_>>()
        .join("\n");
    if text.encode_utf16().count() > MAX_RESULT_CHARS {
        return Err(());
    }
    Ok(text)
}

fn read_local(options: &ReadOptions) -> Result<String, ()> {
    let file = open_regular(&options.path)?;
    if options.offset < 0 {
        read_from_end(file, (-options.offset) as usize, options.length)
    } else {
        read_forward(file, options.offset as usize, options.length)
    }
}

pub(crate) fn read_default_path(path: &str) -> Result<String, ()> {
    read_local(&ReadOptions {
        path: path.to_owned(),
        offset: 0,
        length: 1000,
    })
}

/// Build a bounded owner read_result. Excessive text is never partially sent.
pub fn execute_read_frame(command: &ReadCommand) -> String {
    let (id, result) = match command {
        ReadCommand::File {
            request_id,
            options,
        } => (request_id, read_local(options)),
        ReadCommand::Browse {
            request_id,
            command,
        } => (request_id, crate::native_browse::execute_browse(command)),
        ReadCommand::Failed { request_id } => (request_id, Err(())),
    };
    if let Ok(text) = result {
        let success =
            json!({"kind":"read_result","request_id":id,"status":"completed","text":text})
                .to_string();
        if success.len() <= MAX_WIRE_BYTES && text.encode_utf16().count() <= MAX_WIRE_BYTES {
            return success;
        }
        return json!({"kind":"read_result","request_id":id,"status":"failed","error":"result_too_large"}).to_string();
    }
    json!({"kind":"read_result","request_id":id,"status":"failed"}).to_string()
}

/// Consume only transport-authenticated work. The lease prevents a queued read
/// from starting after Stop/revocation and drops any reply from an old socket.
pub fn run_native_read_executor(
    stop: &std::sync::Arc<std::sync::atomic::AtomicBool>,
    incoming: &std::sync::mpsc::Receiver<crate::session::ExecutionRequest>,
    outgoing: &std::sync::mpsc::SyncSender<crate::session::ExecutionResponse>,
) -> Result<(), NativeReadExecutorError> {
    use std::sync::atomic::Ordering;
    use std::sync::mpsc::{RecvTimeoutError, TrySendError};
    use std::time::Duration;
    while !stop.load(Ordering::Acquire) {
        let request = match incoming.recv_timeout(Duration::from_millis(100)) {
            Ok(request) => request,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => break,
        };
        let Some(frame) = request.frame_if_active() else {
            continue;
        };
        let command = parse_read_frame(frame).map_err(|_| NativeReadExecutorError::Policy)?;
        // Re-check directly before the filesystem open. A read is not a
        // mutation; revocation mid-read still suppresses its response.
        if !request.lease().is_active() {
            continue;
        }
        let response = execute_read_frame(&command);
        if !request.lease().is_active() {
            continue;
        }
        match outgoing.try_send(request.response(response)) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => return Err(NativeReadExecutorError::Queue),
            Err(TrySendError::Disconnected(_)) => break,
        }
    }
    Ok(())
}

#[derive(Debug, thiserror::Error)]
pub enum NativeReadExecutorError {
    #[error("unrecognized or malformed native read frame")]
    Policy,
    #[error("native read response queue is full")]
    Queue,
}

/// Complete but non-installable read-only candidate loop. The channels are
/// bounded; the executor runs independently of heartbeat and grant probes.
/// This deliberately provides no device_info, search, install, upgrade or Shell path.
pub fn run_native_read_session(
    endpoint: &str,
    private_pem: &str,
    device_id: &str,
    stop: &std::sync::Arc<std::sync::atomic::AtomicBool>,
    timing: crate::session::HeartbeatTiming,
) -> Result<(), NativeReadRuntimeError> {
    use std::sync::atomic::Ordering;
    use std::sync::mpsc::sync_channel;
    let (request_sender, requests) = sync_channel(4);
    let (response_sender, responses) = sync_channel(4);
    let worker_stop = std::sync::Arc::clone(stop);
    let worker = std::thread::spawn(move || {
        run_native_read_executor(&worker_stop, &requests, &response_sender)
    });
    let session = crate::session::maintain_native_read_transport(
        endpoint,
        private_pem,
        device_id,
        stop,
        &request_sender,
        &responses,
        timing,
    );
    stop.store(true, Ordering::Release);
    let executor = worker
        .join()
        .map_err(|_| NativeReadRuntimeError::Panicked)?;
    executor?;
    session?;
    Ok(())
}

#[derive(Debug, thiserror::Error)]
pub enum NativeReadRuntimeError {
    #[error(transparent)]
    Session(#[from] crate::session::SessionError),
    #[error(transparent)]
    Executor(#[from] NativeReadExecutorError),
    #[error("native read executor panicked")]
    Panicked,
}
