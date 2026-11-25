//! Same owner-private bounded diagnostic events as the Windows Node Agent.
use crate::{seal_new_windows_private_file, validate_windows_private_path};
use serde_json::{json, Value};
use std::fs::{self, File, OpenOptions};
use std::io::{self, ErrorKind, Read, Seek, SeekFrom, Write};
use std::path::Path;

const LOG: &str = "agent-events.ndjson";
const PREVIOUS: &str = "agent-events.previous.ndjson";
const MAX_BYTES: u64 = 256 * 1024;
const MAX_VIEW_BYTES: u64 = 64 * 1024;
const MAX_LINES: usize = 80;

fn known(event: &str) -> bool {
    matches!(
        event,
        "starting"
            | "connected"
            | "disconnected"
            | "rejected"
            | "stopping"
            | "owner_stopped"
            | "receipt_unsafe_path"
            | "receipt_incompatible"
            | "receipt_owner_unavailable"
            | "receipt_corrupt"
            | "receipt_readonly"
            | "receipt_full"
            | "receipt_storage_unavailable"
            | "authorization_unavailable"
            | "connection_protocol_unavailable"
            | "worker_unavailable"
            | "heartbeat_timeout"
            | "connection_superseded"
            | "execution_queue_unavailable"
            | "connection_unavailable"
            | "execution_unavailable"
            | "upgrade_control_unavailable"
            | "cleanup_uncertain"
            | "automatic_check_refused"
            | "automatic_check_unconfirmed"
            | "automatic_check_launch_failed"
            | "connection_proof_write_failed"
    )
}
fn unsafe_log() -> io::Error {
    io::Error::new(ErrorKind::PermissionDenied, "unsafe Windows Agent log")
}
fn private_size(path: &Path) -> io::Result<Option<u64>> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
        Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => {
            validate_windows_private_path(path, false).map_err(|_| unsafe_log())?;
            Ok(Some(meta.len()))
        }
        _ => Err(unsafe_log()),
    }
}
fn append(root: &Path, event: &str) -> io::Result<()> {
    validate_windows_private_path(root, true).map_err(|_| unsafe_log())?;
    let path = root.join(LOG);
    if private_size(&path)?.is_some_and(|size| size > MAX_BYTES) {
        let backup = root.join(PREVIOUS);
        private_size(&backup)?;
        fs::rename(&path, backup).map_err(|_| unsafe_log())?;
    }
    let mut file = if private_size(&path)?.is_some() {
        OpenOptions::new()
            .append(true)
            .open(&path)
            .map_err(|_| unsafe_log())?
    } else {
        let file = OpenOptions::new()
            .append(true)
            .create_new(true)
            .open(&path)
            .map_err(|_| unsafe_log())?;
        seal_new_windows_private_file(&path).map_err(|_| unsafe_log())?;
        file
    };
    let line = format!(
        "{}\n",
        json!({"utc":crate::windows_managed::utc_clock(),"event":event})
    );
    file.write_all(line.as_bytes()).map_err(|_| unsafe_log())
}
/// Telemetry is best effort and never controls authorization or WSS.
pub fn record(root: &Path, event: &str) {
    if known(event) {
        let _ = append(root, event);
    }
}
fn valid_utc(value: &str) -> bool {
    // Both installed runtimes emit UTC ISO milliseconds. Reflect only
    // this fixed timestamp shape, never arbitrary strings from log files.
    let bytes = value.as_bytes();
    bytes.len() == 24
        && bytes.iter().enumerate().all(|(i, byte)| match i {
            4 | 7 => *byte == b'-',
            10 => *byte == b'T',
            13 | 16 => *byte == b':',
            19 => *byte == b'.',
            23 => *byte == b'Z',
            _ => byte.is_ascii_digit(),
        })
}
pub fn read_events(root: &Path) -> io::Result<String> {
    let path = root.join(LOG);
    let Some(size) = private_size(&path)? else {
        return Ok("No local Windows Agent events.\n".into());
    };
    if size > 1024 * 1024 {
        return Err(unsafe_log());
    }
    let mut file = File::open(path).map_err(|_| unsafe_log())?;
    file.seek(SeekFrom::Start(size.saturating_sub(MAX_VIEW_BYTES)))
        .map_err(|_| unsafe_log())?;
    let mut bytes = Vec::new();
    file.take(MAX_VIEW_BYTES)
        .read_to_end(&mut bytes)
        .map_err(|_| unsafe_log())?;
    let text = String::from_utf8_lossy(&bytes);
    let mut rows = text
        .lines()
        .rev()
        .filter(|line| !line.is_empty())
        .take(MAX_LINES)
        .filter_map(|line| {
            let value: Value = serde_json::from_str(line).ok()?;
            let object = value.as_object()?;
            let utc = object.get("utc")?.as_str()?;
            let event = object.get("event")?.as_str()?;
            (object.len() == 2 && valid_utc(utc) && known(event))
                .then(|| json!({"utc":utc,"event":event}).to_string())
        })
        .collect::<Vec<_>>();
    rows.reverse();
    if rows.is_empty() {
        Ok("No valid local Windows Agent events.\n".into())
    } else {
        Ok(rows.join("\n") + "\n")
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fixed_events_are_private_bounded_and_never_reflect_arbitrary_content() {
        let dir = tempfile::tempdir().unwrap();
        crate::seal_new_windows_private_directory(dir.path()).unwrap();
        record(dir.path(), "connected");
        record(dir.path(), "receipt_corrupt");
        record(dir.path(), "authorization_unavailable");
        record(dir.path(), "not-a-reviewed-event");
        let path = dir.path().join(LOG);
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(
            file,
            "{{\"utc\":\"sensitive value\",\"event\":\"connected\"}}"
        )
        .unwrap();
        writeln!(file, "{{\"utc\":\"2026-11-24T00:00:00.000Z\",\"event\":\"connected\",\"private\":\"sensitive value\"}}").unwrap();
        drop(file);
        let output = read_events(dir.path()).unwrap();
        assert_eq!(output.lines().count(), 3);
        assert!(output.contains("receipt_corrupt"));
        assert!(output.contains("authorization_unavailable"));
        assert!(output.contains("connected"));
        assert!(!output.contains("sensitive"));
        let file = OpenOptions::new().write(true).open(&path).unwrap();
        file.set_len(MAX_BYTES + 1).unwrap();
        drop(file);
        record(dir.path(), "stopping");
        assert!(dir.path().join(PREVIOUS).is_file());
        assert!(read_events(dir.path()).unwrap().contains("stopping"));
        assert!(fs::metadata(path).unwrap().len() < 256);
    }
}
