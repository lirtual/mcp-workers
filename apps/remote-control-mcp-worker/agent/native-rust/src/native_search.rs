//! Bounded, in-memory native search for authenticated file/managed WSS sessions.
//! Search is read-only and intentionally has no persistent receipt or cursor store.
use crate::receipt_boundary::ReceiptBoundary;
use crate::session::ExecutionLease;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
#[cfg(target_os = "linux")]
use std::fs::{File, ReadDir};
use std::io::Read;
#[cfg(target_os = "linux")]
use std::os::fd::AsRawFd;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::Arc;
use std::time::{Duration, Instant};

const PAGE_SIZE: usize = 20;
const MAX_SESSIONS: usize = 4;
const SCAN_TIME: Duration = Duration::from_secs(15);
const SESSION_TTL: Duration = Duration::from_secs(60);
const PAGE_WAIT: Duration = Duration::from_millis(1500);
const MAX_DEPTH: usize = 8;
const MAX_ENTRIES: usize = 20_000;
const MAX_RESULTS: usize = 500;
const MAX_TOTAL_BYTES: usize = 32 * 1024 * 1024;
const MAX_FILE_BYTES: usize = 2 * 1024 * 1024;
const MAX_MATCH_CHARS: usize = 240;
const MAX_LINE_CHARS: usize = 16_384;
const MAX_WIRE_BYTES: usize = 65_536;

// Open a directory without following a replaced symlink; enumerate the stable
// descriptor, not its mutable path. /proc/self/fd is an OS-owned fd reference.
#[cfg(target_os = "linux")]
fn open_directory_secure(path: &Path) -> Result<(File, ReadDir), ()> {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW);
    let handle = options.open(path).map_err(|_| ())?;
    let entries = fs::read_dir(format!("/proc/self/fd/{}", handle.as_raw_fd())).map_err(|_| ())?;
    Ok((handle, entries))
}

#[derive(Clone, Copy)]
pub(crate) enum SearchType {
    Filename,
    Content,
}

#[derive(Clone)]
pub(crate) enum SearchCommand {
    Start {
        path: PathBuf,
        pattern: String,
        search_type: SearchType,
    },
    More(String),
    Stop(String),
}

pub(crate) struct SearchFrame {
    pub request_id: String,
    pub command: Option<SearchCommand>,
}

fn valid_cursor(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            14 => b == b'4',
            19 => matches!(b, b'8' | b'9' | b'a' | b'b'),
            _ => b.is_ascii_digit() || (b'a'..=b'f').contains(&b),
        })
}

fn parse_command(tool: &str, value: &Value) -> Option<SearchCommand> {
    let args = value.as_object()?;
    match tool {
        "start_search" => {
            if args.len() != 3 {
                return None;
            }
            let path = args.get("path")?.as_str()?;
            if !crate::native_read::permitted_path(path) {
                return None;
            }
            let pattern = args.get("pattern")?.as_str()?;
            if pattern.is_empty() || pattern.contains('\0') || pattern.encode_utf16().count() > 256
            {
                return None;
            }
            let search_type = match args.get("search_type")?.as_str()? {
                "filename" => SearchType::Filename,
                "content" => SearchType::Content,
                _ => return None,
            };
            Some(SearchCommand::Start {
                path: PathBuf::from(path),
                pattern: pattern.to_owned(),
                search_type,
            })
        }
        "get_more_search_results" | "stop_search" => {
            if args.len() != 1 {
                return None;
            }
            let id = args.get("session_id")?.as_str()?;
            if !valid_cursor(id) {
                return None;
            }
            if tool == "stop_search" {
                Some(SearchCommand::Stop(id.to_owned()))
            } else {
                Some(SearchCommand::More(id.to_owned()))
            }
        }
        _ => None,
    }
}

/// Unknown tools stay in the existing 1008 parser. Bad arguments of a *known*
/// search tool produce a failed read but do not revoke the signed WSS session.
pub(crate) fn parse_frame(object: &Map<String, Value>) -> Option<Result<SearchFrame, ()>> {
    let tool = object.get("tool")?.as_str()?;
    if !matches!(
        tool,
        "start_search" | "get_more_search_results" | "stop_search"
    ) {
        return None;
    }
    Some((|| {
        if object.len() != 4 || object.get("kind").and_then(Value::as_str) != Some("read") {
            return Err(());
        }
        let request_id = object.get("request_id").and_then(Value::as_str).ok_or(())?;
        if !crate::identity::valid_device_id(request_id) {
            return Err(());
        }
        let args = object.get("arguments").ok_or(())?;
        Ok(SearchFrame {
            request_id: request_id.to_owned(),
            command: parse_command(tool, args),
        })
    })())
}

#[derive(Serialize)]
#[serde(untagged)]
enum Hit {
    Path {
        path: String,
    },
    Line {
        path: String,
        line: usize,
        text: String,
    },
}

#[derive(Serialize)]
struct Page {
    results: Vec<Hit>,
    has_more: bool,
    truncated: bool,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
}
enum Event {
    Match(Hit),
    Done(bool),
    Failed,
}

#[derive(Default)]
struct Counts {
    entries: usize,
    matches: usize,
    bytes: usize,
    truncated: bool,
}

struct Scan<'a> {
    deadline: Instant,
    cancelled: &'a AtomicBool,
    sender: &'a SyncSender<Event>,
    truncated_flag: &'a AtomicBool,
    counts: Counts,
    boundary: Option<&'a ReceiptBoundary>,
}
impl Scan<'_> {
    fn mark_truncated(&mut self) {
        self.counts.truncated = true;
        self.truncated_flag.store(true, Ordering::Release);
    }
    fn active(&mut self) -> bool {
        if self.cancelled.load(Ordering::Acquire) {
            return false;
        }
        if Instant::now() >= self.deadline || self.counts.bytes >= MAX_TOTAL_BYTES {
            self.mark_truncated();
            return false;
        }
        true
    }
    fn hit(&mut self, hit: Hit) -> bool {
        self.counts.matches += 1;
        if self.sender.send(Event::Match(hit)).is_err() {
            return false;
        }
        if self.counts.matches >= MAX_RESULTS {
            self.mark_truncated();
            return false;
        }
        self.active()
    }
    fn content(&mut self, path: &Path, relative: &str, pattern: &str) -> Result<bool, ()> {
        if self.boundary.is_some_and(|b| b.blocks(path)) {
            return Ok(true);
        }
        let info = fs::metadata(path).map_err(|_| ())?;
        if info.len() > MAX_FILE_BYTES as u64 {
            self.mark_truncated();
            return Ok(true);
        }
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        let mut file = options.open(path).map_err(|_| ())?;
        let info = file.metadata().map_err(|_| ())?;
        if !info.is_file() {
            return Ok(true);
        }
        if info.len() > MAX_FILE_BYTES as u64 {
            self.mark_truncated();
            return Ok(true);
        }
        // Bound memory even when a regular file grows between stat and read.
        let mut bytes = Vec::with_capacity(info.len() as usize);
        file.by_ref()
            .take((MAX_FILE_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| ())?;
        if bytes.len() > MAX_FILE_BYTES {
            self.mark_truncated();
            return Ok(true);
        }
        self.counts.bytes += bytes.len();
        if self.counts.bytes > MAX_TOTAL_BYTES {
            self.mark_truncated();
            return Ok(false);
        }
        let decoded = String::from_utf8_lossy(&bytes);
        for (index, line) in decoded.split_inclusive('\n').enumerate() {
            if !self.active() {
                return Ok(false);
            }
            let line = line.strip_suffix('\n').unwrap_or(line);
            let line = line.strip_suffix('\r').unwrap_or(line);
            if line.encode_utf16().count() > MAX_LINE_CHARS {
                self.mark_truncated();
                continue;
            }
            if !line.contains(pattern) {
                continue;
            }
            let text: String = line
                .chars()
                .scan(0, |n, c| {
                    let next = *n + c.len_utf16();
                    if next > MAX_MATCH_CHARS {
                        None
                    } else {
                        *n = next;
                        Some(c)
                    }
                })
                .collect();
            if !self.hit(Hit::Line {
                path: relative.to_owned(),
                line: index + 1,
                text,
            }) {
                return Ok(false);
            }
        }
        Ok(true)
    }
    fn walk(
        &mut self,
        directory: &Path,
        relative: &Path,
        depth: usize,
        pattern: &str,
        kind: SearchType,
    ) -> Result<bool, ()> {
        if !self.active() {
            return Ok(false);
        }
        if matches!(kind, SearchType::Content) && self.boundary.is_some_and(|b| b.blocks(directory))
        {
            return Ok(true);
        }
        let info = fs::symlink_metadata(directory).map_err(|_| ())?;
        if !info.file_type().is_dir() {
            return Err(());
        }
        #[cfg(target_os = "linux")]
        let (_directory_handle, entries) = open_directory_secure(directory)?;
        #[cfg(not(target_os = "linux"))]
        let entries = fs::read_dir(directory).map_err(|_| ())?;
        for entry in entries {
            if !self.active() {
                return Ok(false);
            }
            self.counts.entries += 1;
            if self.counts.entries > MAX_ENTRIES {
                self.mark_truncated();
                return Ok(false);
            }
            let entry = entry.map_err(|_| ())?;
            let file_type = entry.file_type().map_err(|_| ())?;
            let child = relative.join(entry.file_name());
            let text = child.to_string_lossy().into_owned();
            if matches!(kind, SearchType::Filename)
                && text.contains(pattern)
                && !self.hit(Hit::Path { path: text.clone() })
            {
                return Ok(false);
            }
            if matches!(kind, SearchType::Content)
                && file_type.is_file()
                && !self.content(&entry.path(), &text, pattern)?
            {
                return Ok(false);
            }
            if file_type.is_dir()
                && depth < MAX_DEPTH
                && !self.walk(&entry.path(), &child, depth + 1, pattern, kind)?
            {
                return Ok(false);
            }
        }
        Ok(true)
    }
}

struct Cursor {
    receiver: Receiver<Event>,
    cancel: Arc<AtomicBool>,
    truncated_flag: Arc<AtomicBool>,
    created: Instant,
    pending: Option<Hit>,
}
impl Drop for Cursor {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Release);
    }
}

#[derive(Debug, PartialEq, Eq)]
enum SearchError {
    Failed,
    NotFound,
    Conflict,
}

pub(crate) struct SearchSessions {
    cursors: HashMap<String, Cursor>,
    ttl: Duration,
    lease: Option<ExecutionLease>,
    boundary: Option<ReceiptBoundary>,
}
impl Default for SearchSessions {
    fn default() -> Self {
        Self {
            cursors: HashMap::new(),
            ttl: SESSION_TTL,
            lease: None,
            boundary: None,
        }
    }
}
impl SearchSessions {
    pub(crate) fn with_boundary(boundary: ReceiptBoundary) -> Self {
        Self {
            boundary: Some(boundary),
            ..Self::default()
        }
    }
    pub(crate) fn expire(&mut self) {
        if self.lease.as_ref().is_some_and(|lease| !lease.is_active()) {
            self.cursors.clear(); // Dropping receivers also unblocks producers.
            self.lease = None;
        }
        self.cursors.retain(|_, c| c.created.elapsed() < self.ttl);
    }
    fn new_id() -> Result<String, SearchError> {
        let mut random = [0_u8; 16];
        getrandom::fill(&mut random).map_err(|_| SearchError::Failed)?;
        random[6] = (random[6] & 0x0f) | 0x40;
        random[8] = (random[8] & 0x3f) | 0x80;
        let h: String = random.iter().map(|b| format!("{b:02x}")).collect();
        Ok(format!(
            "{}-{}-{}-{}-{}",
            &h[..8],
            &h[8..12],
            &h[12..16],
            &h[16..20],
            &h[20..]
        ))
    }
    fn start(
        &mut self,
        path: PathBuf,
        pattern: String,
        kind: SearchType,
        reply_deadline: Instant,
    ) -> Result<Page, SearchError> {
        self.expire();
        if self.cursors.len() >= MAX_SESSIONS {
            return Err(SearchError::Conflict);
        }
        let id = Self::new_id()?;
        let (sender, receiver) = mpsc::sync_channel(1);
        let cancel = Arc::new(AtomicBool::new(false));
        let worker_cancel = Arc::clone(&cancel);
        let truncated_flag = Arc::new(AtomicBool::new(false));
        let worker_truncated = Arc::clone(&truncated_flag);
        let boundary = self.boundary.clone();
        std::thread::Builder::new()
            .name("rca-native-search".into())
            .spawn(move || {
                let mut scan = Scan {
                    deadline: Instant::now() + SCAN_TIME,
                    cancelled: &worker_cancel,
                    sender: &sender,
                    truncated_flag: &worker_truncated,
                    counts: Counts::default(),
                    boundary: boundary.as_ref(),
                };
                let outcome = scan.walk(&path, Path::new(""), 1, &pattern, kind);
                if !worker_cancel.load(Ordering::Acquire) {
                    let done = match outcome {
                        Ok(_) => Event::Done(scan.counts.truncated),
                        Err(()) => Event::Failed,
                    };
                    let _ = sender.send(done);
                }
            })
            .map_err(|_| SearchError::Failed)?;
        self.cursors.insert(
            id.clone(),
            Cursor {
                receiver,
                cancel,
                truncated_flag,
                created: Instant::now(),
                pending: None,
            },
        );
        self.page(&id, reply_deadline)
    }
    fn page(&mut self, id: &str, reply_deadline: Instant) -> Result<Page, SearchError> {
        self.expire();
        let cursor = self.cursors.get_mut(id).ok_or(SearchError::NotFound)?;
        let deadline = (Instant::now() + PAGE_WAIT).min(reply_deadline);
        let mut results = Vec::new();
        if let Some(hit) = cursor.pending.take() {
            results.push(hit);
        }
        let mut waiting = false;
        let mut finished = false;
        let mut truncated = false;
        while results.len() <= PAGE_SIZE {
            if self.lease.as_ref().is_some_and(|lease| !lease.is_active()) {
                self.cursors.remove(id);
                return Err(SearchError::Failed);
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                waiting = true;
                break;
            }
            match cursor
                .receiver
                .recv_timeout(left.min(Duration::from_millis(25)))
            {
                Ok(Event::Match(hit)) if results.len() == PAGE_SIZE => {
                    cursor.pending = Some(hit);
                    break;
                }
                Ok(Event::Match(hit)) => results.push(hit),
                Ok(Event::Done(value)) => {
                    finished = true;
                    truncated = value;
                    break;
                }
                Ok(Event::Failed) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                    self.cursors.remove(id);
                    return Err(SearchError::Failed);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
            }
        }
        let has_more = !finished && (waiting || cursor.pending.is_some());
        let truncated = truncated || cursor.truncated_flag.load(Ordering::Acquire);
        let page = Page {
            results,
            has_more,
            truncated,
            status: if has_more { "running" } else { "complete" },
            session_id: has_more.then(|| id.to_owned()),
        };
        if !has_more {
            self.cursors.remove(id);
        }
        Ok(page)
    }
    fn stop(&mut self, id: &str) -> Result<Page, SearchError> {
        self.expire();
        self.cursors.remove(id).ok_or(SearchError::NotFound)?;
        Ok(Page {
            results: vec![],
            has_more: false,
            truncated: false,
            status: "stopped",
            session_id: None,
        })
    }
    pub(crate) fn execute_scoped(
        &mut self,
        frame: &SearchFrame,
        lease: &ExecutionLease,
        reply_deadline: Instant,
    ) -> String {
        self.expire();
        if !self
            .lease
            .as_ref()
            .is_some_and(|old| old.same_incarnation(lease))
        {
            self.cursors.clear();
            self.lease = Some(lease.clone());
        }
        self.execute(frame, reply_deadline)
    }

    fn execute(&mut self, frame: &SearchFrame, reply_deadline: Instant) -> String {
        let outcome = match frame.command.clone() {
            Some(SearchCommand::Start {
                path,
                pattern,
                search_type,
            }) => self.start(path, pattern, search_type, reply_deadline),
            Some(SearchCommand::More(id)) => self.page(&id, reply_deadline),
            Some(SearchCommand::Stop(id)) => self.stop(&id),
            None => Err(SearchError::Failed),
        };
        match outcome {
            Ok(page) => {
                let response = json!({"kind":"read_result","request_id":frame.request_id,
                    "status":"completed","text":serde_json::to_string(&page).expect("valid page")})
                .to_string();
                if response.len() <= MAX_WIRE_BYTES {
                    response
                } else {
                    json!({"kind":"read_result","request_id":frame.request_id,
                    "status":"failed","error":"result_too_large"})
                    .to_string()
                }
            }
            Err(_) => json!({"kind":"read_result","request_id":frame.request_id,"status":"failed"})
                .to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::thread;
    const ID: &str = "11111111-1111-1111-1111-111111111111";
    fn call(s: &mut SearchSessions, tool: &str, args: Value) -> Value {
        let frame = json!({"kind":"read","request_id":ID,"tool":tool,"arguments":args});
        let parsed = parse_frame(frame.as_object().unwrap()).unwrap().unwrap();
        serde_json::from_str(&s.execute(&parsed, Instant::now() + PAGE_WAIT)).unwrap()
    }
    fn page(value: Value) -> Value {
        assert_eq!(value["status"], "completed", "{value}");
        serde_json::from_str(value["text"].as_str().unwrap()).unwrap()
    }
    fn start(s: &mut SearchSessions, root: &Path, pattern: &str, kind: &str) -> Value {
        page(call(
            s,
            "start_search",
            json!({"path":root,"pattern":pattern,"search_type":kind}),
        ))
    }
    #[test]
    fn filename_literal_case_sensitive_and_two_pages_no_loss() {
        let root = tempfile::tempdir().unwrap();
        for i in 0..25 {
            fs::write(root.path().join(format!("Needle-{i:02}.txt")), b"x").unwrap();
        }
        fs::write(root.path().join("needle-lower.txt"), b"x").unwrap();
        let mut s = SearchSessions::default();
        let first = start(&mut s, root.path(), "Needle", "filename");
        assert_eq!(first["results"].as_array().unwrap().len(), 20);
        assert_eq!(first["status"], "running");
        let id = first["session_id"].as_str().unwrap().to_owned();
        assert!(valid_cursor(&id));
        let second = page(call(
            &mut s,
            "get_more_search_results",
            json!({"session_id":id}),
        ));
        assert_eq!(second["status"], "complete");
        assert_eq!(second["results"].as_array().unwrap().len(), 5);
        let mut names: Vec<_> = first["results"]
            .as_array()
            .unwrap()
            .iter()
            .chain(second["results"].as_array().unwrap())
            .map(|x| x["path"].as_str().unwrap().to_owned())
            .collect();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), 25);
        assert!(!names.iter().any(|n| n.contains("lower")));
        assert_eq!(
            call(&mut s, "get_more_search_results", json!({"session_id":id}))["status"],
            "failed"
        );
    }
    #[test]
    fn content_relative_line_numbers_utf8_and_preview_cap() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("child")).unwrap();
        fs::write(
            root.path().join("child/a.txt"),
            "alpha\r\nneedle Ω😀\r\nx\nneedle END",
        )
        .unwrap();
        fs::write(
            root.path().join("child/b.txt"),
            format!("needle {}", "x".repeat(500)),
        )
        .unwrap();
        let mut s = SearchSessions::default();
        let result = start(&mut s, root.path(), "needle", "content");
        assert_eq!(result["status"], "complete");
        let lines = result["results"].as_array().unwrap();
        assert_eq!(lines.len(), 3);
        // The Node reference uses path.join for relative results, preserving
        // native separators (backslash on Windows, slash on Unix).
        let child_a = Path::new("child")
            .join("a.txt")
            .to_string_lossy()
            .into_owned();
        let child_b = Path::new("child")
            .join("b.txt")
            .to_string_lossy()
            .into_owned();
        assert!(lines.iter().any(|v| {
            v["path"].as_str() == Some(child_a.as_str())
                && v["line"] == 2
                && v["text"] == "needle Ω😀"
        }));
        assert!(lines
            .iter()
            .any(|v| { v["path"].as_str() == Some(child_a.as_str()) && v["line"] == 4 }));
        let preview = lines
            .iter()
            .find(|v| v["path"].as_str() == Some(child_b.as_str()))
            .unwrap()["text"]
            .as_str()
            .unwrap();
        assert_eq!(preview.encode_utf16().count(), MAX_MATCH_CHARS);
    }
    #[cfg(unix)]
    #[test]
    fn symlink_root_escape_and_cycle_not_followed() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(root.path().join("good.txt"), b"needle").unwrap();
        fs::write(outside.path().join("secret.txt"), b"needle").unwrap();
        symlink(outside.path(), root.path().join("escape")).unwrap();
        symlink(root.path(), root.path().join("cycle")).unwrap();
        symlink(root.path(), root.path().join("root_link")).unwrap();
        let mut s = SearchSessions::default();
        let result = start(&mut s, root.path(), "needle", "content");
        assert_eq!(result["results"].as_array().unwrap().len(), 1);
        assert_eq!(result["results"][0]["path"], "good.txt");
        assert_eq!(
            call(
                &mut s,
                "start_search",
                json!({
                    "path":root.path().join("root_link"),"pattern":"needle","search_type":"content"
                })
            )["status"],
            "failed"
        );
    }
    #[test]
    fn oversized_file_and_line_mark_truncated_and_skip_data() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("big.txt"), vec![b'n'; MAX_FILE_BYTES + 1]).unwrap();
        fs::write(
            root.path().join("long.txt"),
            format!("needle{}\nneedle ok", "x".repeat(MAX_LINE_CHARS)),
        )
        .unwrap();
        let mut s = SearchSessions::default();
        let result = start(&mut s, root.path(), "needle", "content");
        assert_eq!(result["status"], "complete");
        assert_eq!(result["truncated"], true);
        assert_eq!(result["results"].as_array().unwrap().len(), 1);
        assert_eq!(result["results"][0]["line"], 2);
    }
    #[test]
    fn malformed_args_missing_root_and_forged_cursor_do_not_leak_path() {
        let mut s = SearchSessions::default();
        let missing = "/unlikely-native-search-missing-914-9bc7";
        let result = call(
            &mut s,
            "start_search",
            json!({"path":missing,"pattern":"a","search_type":"filename"}),
        );
        assert_eq!(result["status"], "failed");
        assert!(!result.to_string().contains(missing));
        for args in [
            json!({"path":"/tmp","pattern":"","search_type":"content"}),
            json!({"path":"/tmp","pattern":"a","search_type":"content","extra":true}),
            json!({"path":"https://example.com","pattern":"a","search_type":"content"}),
            json!({"path":"/tmp","pattern":"a".repeat(257),"search_type":"filename"}),
            json!({"path":"/tmp","pattern":"a","search_type":"regex"}),
        ] {
            assert_eq!(call(&mut s, "start_search", args)["status"], "failed");
        }
        assert_eq!(
            call(
                &mut s,
                "get_more_search_results",
                json!({
                    "session_id":"00000000-0000-4000-8000-000000000000"
                })
            )["status"],
            "failed"
        );
        assert!(!valid_cursor("00000000-0000-4000-f000-000000000000"));
    }
    #[test]
    fn four_session_cap_stop_ttl_and_deadline() {
        let root = tempfile::tempdir().unwrap();
        for i in 0..30 {
            fs::write(root.path().join(format!("match-{i}.txt")), b"x").unwrap();
        }
        let mut s = SearchSessions::default();
        let ids: Vec<String> = (0..4)
            .map(|_| {
                start(&mut s, root.path(), "match", "filename")["session_id"]
                    .as_str()
                    .unwrap()
                    .to_owned()
            })
            .collect();
        assert_eq!(
            call(
                &mut s,
                "start_search",
                json!({
                    "path":root.path(),"pattern":"match","search_type":"filename"
                })
            )["status"],
            "failed"
        );
        assert_eq!(
            page(call(&mut s, "stop_search", json!({"session_id":ids[0]})))["status"],
            "stopped"
        );
        assert_eq!(
            call(
                &mut s,
                "get_more_search_results",
                json!({"session_id":ids[0]})
            )["status"],
            "failed"
        );
        assert_eq!(
            start(&mut s, root.path(), "match", "filename")["status"],
            "running"
        );
        s.ttl = Duration::from_millis(1);
        thread::sleep(Duration::from_millis(5));
        assert_eq!(
            call(
                &mut s,
                "get_more_search_results",
                json!({"session_id":ids[1]})
            )["status"],
            "failed"
        );
        assert!(s.cursors.is_empty());
        let cancelled = AtomicBool::new(false);
        let (sender, _receiver) = mpsc::sync_channel(1);
        let mut scan = Scan {
            deadline: Instant::now() - Duration::from_secs(1),
            cancelled: &cancelled,
            sender: &sender,
            truncated_flag: &cancelled,
            counts: Counts::default(),
            boundary: None,
        };
        assert_eq!(
            scan.walk(
                Path::new("/unreadable"),
                Path::new(""),
                1,
                "x",
                SearchType::Filename
            ),
            Ok(false)
        );
        assert!(scan.counts.truncated);
    }

    #[test]
    fn expiry_releases_idle_cursor_without_a_followup_request() {
        let root = tempfile::tempdir().unwrap();
        for n in 0..30 {
            fs::write(root.path().join(format!("match-{n}.txt")), "ok").unwrap();
        }
        let mut s = SearchSessions::default();
        let first = start(&mut s, root.path(), "match", "filename");
        let cursor = first["session_id"].as_str().unwrap().to_owned();
        s.ttl = Duration::from_millis(1);
        thread::sleep(Duration::from_millis(5));
        // The file executor calls expire() each 100ms even with no new frame.
        s.expire();
        assert!(s.cursors.is_empty());
        assert_eq!(
            call(
                &mut s,
                "get_more_search_results",
                json!({"session_id":cursor})
            )["status"],
            "failed"
        );
    }

    #[test]
    fn expired_relay_wait_preserves_running_cursor_without_waiting_for_producer() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let id = SearchSessions::new_id().unwrap();
        let mut sessions = SearchSessions::default();
        sessions.cursors.insert(
            id.clone(),
            Cursor {
                receiver,
                cancel: Arc::new(AtomicBool::new(false)),
                truncated_flag: Arc::new(AtomicBool::new(false)),
                created: Instant::now(),
                pending: None,
            },
        );
        let page = sessions.page(&id, Instant::now()).unwrap();
        assert!(page.has_more);
        assert_eq!(page.status, "running");
        assert!(page.results.is_empty());
        let producer = thread::spawn(move || {
            sender
                .send(Event::Match(Hit::Path {
                    path: "next".into(),
                }))
                .unwrap();
            sender.send(Event::Done(false)).unwrap();
        });
        let next = sessions.page(&id, Instant::now() + PAGE_WAIT).unwrap();
        assert_eq!(next.results.len(), 1);
        assert!(!next.has_more);
        producer.join().unwrap();
    }

    #[test]
    fn running_page_reports_shared_truncation_before_done_event() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let producer = thread::spawn(move || {
            for n in 0..21 {
                if sender
                    .send(Event::Match(Hit::Path {
                        path: format!("hit-{n}"),
                    }))
                    .is_err()
                {
                    return;
                }
            }
        });
        let id = SearchSessions::new_id().unwrap();
        let mut s = SearchSessions::default();
        s.cursors.insert(
            id.clone(),
            Cursor {
                receiver,
                cancel: Arc::new(AtomicBool::new(false)),
                truncated_flag: Arc::new(AtomicBool::new(true)),
                created: Instant::now(),
                pending: None,
            },
        );
        let result = s.page(&id, Instant::now() + PAGE_WAIT).unwrap();
        assert!(result.has_more);
        assert!(result.truncated);
        assert_eq!(result.results.len(), PAGE_SIZE);
        s.stop(&id).unwrap();
        producer.join().unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn opened_directory_handle_cannot_be_redirected_to_symlink() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let inner = root.path().join("inner");
        fs::create_dir(&inner).unwrap();
        fs::write(inner.join("inside.txt"), "inside").unwrap();
        fs::write(outside.path().join("outside.txt"), "outside").unwrap();
        let (_handle, entries) = open_directory_secure(&inner).unwrap();
        fs::rename(&inner, root.path().join("renamed")).unwrap();
        symlink(outside.path(), &inner).unwrap();
        let names: Vec<_> = entries.map(|entry| entry.unwrap().file_name()).collect();
        assert_eq!(names, vec![std::ffi::OsString::from("inside.txt")]);
        assert!(open_directory_secure(&inner).is_err());
    }
}
