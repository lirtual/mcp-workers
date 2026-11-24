//! Ephemeral activity evidence, only enabled for a verified Ubuntu Session.
//! The execution owner records activity; the existing local IPC exposes a
//! snapshot and atomically freezes new execution. No persisted idle state.
#[cfg(unix)]
use crate::session_enrollment::SessionPhysicalAttempt;
#[cfg(unix)]
use serde_json::json;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Default)]
pub(crate) struct Activity {
    last: Option<u64>,
    uncertain: bool,
}

fn now_ms() -> Option<u64> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis();
    (now <= 9_007_199_254_740_991).then_some(now as u64)
}

impl Activity {
    pub(crate) fn touch(&mut self) {
        match now_ms() {
            Some(now) if self.last.is_none_or(|last| now >= last) => self.last = Some(now),
            _ => self.uncertain = true,
        }
    }

    pub(crate) fn mark_unknown(&mut self) {
        self.uncertain = true;
    }

    #[cfg(unix)]
    pub(crate) fn snapshot(
        &mut self,
        attempt: &SessionPhysicalAttempt,
        healthy: bool,
        busy: bool,
    ) -> (bool, String) {
        let now = now_ms();
        if now.is_none_or(|now| self.last.is_some_and(|last| last > now)) {
            self.uncertain = true;
        }
        let state = if self.uncertain || !healthy {
            "unknown"
        } else if busy {
            "busy"
        } else {
            "idle"
        };
        let frame = json!({
            "attempt_id":attempt.attempt_id,
            "github_run_id":attempt.github_run_id,
            "github_run_attempt":attempt.github_run_attempt,
            "observed_at_ms":now,
            "last_activity_ms":self.last,
            "state":state,
        });
        (state == "idle", format!("{frame}\n"))
    }
}
