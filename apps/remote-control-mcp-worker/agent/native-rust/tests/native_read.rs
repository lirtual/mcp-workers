use rca_native_agent::native_read::{execute_read_frame, parse_read_frame, ReadFrameError};
use serde_json::{json, Value};
use std::io::Write;
use tempfile::{tempdir, NamedTempFile};

fn frame(args: Value) -> String {
    json!({"kind":"read","request_id":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        "tool":"read_file","arguments":args})
    .to_string()
}
fn response(frame: &str) -> Value {
    let cmd = parse_read_frame(frame).expect("valid read envelope");
    serde_json::from_str(&execute_read_frame(&cmd)).unwrap()
}
#[test]
fn node_reference_forward_and_tail_lines_match() {
    let mut file = NamedTempFile::new().unwrap();
    file.write_all(b"line-one\r\nline-two\nline-three\r")
        .unwrap();
    let path = file.path().to_str().unwrap();
    let args = json!({"path":path,"offset":0,"length":2});
    assert_eq!(response(&frame(args))["text"], "line-one\nline-two");
    assert_eq!(
        response(&frame(json!({"path":path,"offset":-2,"length":2})))["text"],
        "line-two\nline-three"
    );
    assert_eq!(
        response(&frame(json!({"path":path,"offset":2,"length":1})))["text"],
        "line-three"
    );
}
#[test]
fn fail_closed_invalid_argument_without_opening_file() {
    for args in [
        json!({"path":"file:///etc/hostname"}),
        json!({"path":"http://example.test/a"}),
        json!({"path":"//server/file"}),
        json!({"path":"x\u{0000}y"}),
        json!({"path":"/unused","isUrl":true}),
        json!({"path":"/unused","length":0}),
        json!({"path":"/unused","length":1001}),
        json!({"path":"/unused","offset":1.5}),
        json!({"path":"/unused","offset":-100001}),
        json!({"path":"/unused","offset":1000001}),
        json!({"path":"/unused","surprise":"yes"}),
    ] {
        let got = response(&frame(args));
        assert_eq!(got["status"], "failed");
        assert_eq!(got.get("text"), None);
    }
}
#[test]
fn invalid_envelope_is_policy_not_a_local_read() {
    for input in [
        "not-json".to_string(),
        json!({"kind":"read","request_id":"not-a-uuid","tool":"read_file","arguments":{"path":"/x"}}).to_string(),
        json!({"kind":"read","request_id":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","tool":"start_process","arguments":{"path":"/x"}}).to_string(),
        json!({"kind":"read","request_id":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","tool":"read_file","arguments":{"path":"/x"},"extra":0}).to_string(),
        json!({"kind":"operation","request_id":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","tool":"write_file","arguments":{"path":"/x"}}).to_string(),
    ] {
        assert!(matches!(parse_read_frame(&input), Err(ReadFrameError::Policy)));
    }
}
#[test]
fn missing_file_directory_fifo_and_oversize_do_not_leak_text() {
    let dir = tempdir().unwrap();
    let path = dir.path().to_str().unwrap();
    for p in [dir.path().join("missing"), dir.path().to_path_buf()] {
        assert_eq!(
            response(&frame(json!({"path":p.to_str().unwrap()})))["status"],
            "failed"
        );
    }
    let file = dir.path().join("huge.txt");
    std::fs::write(&file, "a".repeat(70_000)).unwrap();
    let got = response(&frame(json!({"path":file.to_str().unwrap()})));
    assert_eq!(got["status"], "failed");
    assert_eq!(got["error"], "result_too_large");
    assert!(got.get("text").is_none(), "no truncated secret");
    assert!(!path.is_empty());
}
#[test]
fn non_migrated_read_only_tools_remain_out_of_scope_and_fail_closed() {
    let frame = json!({"kind":"read","request_id":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        "tool":"start_search","arguments":{"path":"/tmp"}})
    .to_string();
    assert!(matches!(
        parse_read_frame(&frame),
        Err(ReadFrameError::Policy)
    ));
}

#[test]
fn node_number_is_integer_accepts_integral_decimals_not_fractional_values() {
    let mut file = NamedTempFile::new().unwrap();
    file.write_all(b"first\nsecond\n").unwrap();
    let path = file.path().to_str().unwrap();
    assert_eq!(
        response(&frame(json!({"path":path,"offset":1.0,"length":1.0})))["text"],
        "second"
    );
    assert_eq!(
        response(&frame(json!({"path":path,"offset":-0.0,"length":1})))["text"],
        "first"
    );
    assert_eq!(
        response(&frame(json!({"path":path,"offset":1.1,"length":1})))["status"],
        "failed"
    );
}
#[test]
fn first_lines_of_huge_file_and_last_lines_are_bounded_in_their_scan_direction() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("large.txt");
    let mut data = b"first\nsecond\n".to_vec();
    data.extend(vec![b'x'; 1_200_000]);
    data.extend_from_slice(b"\ntail-one\ntail-two\n");
    std::fs::write(&path, data).unwrap();
    let path = path.to_str().unwrap();
    assert_eq!(
        response(&frame(json!({"path":path,"offset":0,"length":2})))["text"],
        "first\nsecond"
    );
    assert_eq!(
        response(&frame(json!({"path":path,"offset":-2,"length":2})))["text"],
        "tail-one\ntail-two"
    );
    assert_eq!(
        response(&frame(json!({"path":path,"offset":500_000,"length":1})))["status"],
        "failed"
    );
}
#[test]
fn escaped_json_byte_budget_fails_with_no_partial_text() {
    let mut file = NamedTempFile::new().unwrap();
    file.write_all("\t".repeat(40_000).as_bytes()).unwrap();
    let got = response(&frame(
        json!({"path":file.path().to_str().unwrap(),"length":1}),
    ));
    assert_eq!(got["status"], "failed");
    assert_eq!(got["error"], "result_too_large");
    assert!(got.get("text").is_none());
}
#[cfg(unix)]
#[test]
fn fifo_is_not_opened_as_blocking_read_or_regular_file() {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let dir = tempdir().unwrap();
    let fifo = dir.path().join("pipe");
    let c_path = CString::new(fifo.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);
    let got = response(&frame(json!({"path":fifo.to_str().unwrap()})));
    assert_eq!(got["status"], "failed");
}

#[test]
fn overlong_unterminated_line_fails_even_when_offset_would_skip_it() {
    let mut file = NamedTempFile::new().unwrap();
    file.write_all("a".repeat(350_000).as_bytes()).unwrap();
    file.write_all(b"\nlast\n").unwrap();
    let got = response(&frame(
        json!({"path":file.path().to_str().unwrap(),"offset":1,"length":1}),
    ));
    assert_eq!(got["status"], "failed");
    assert!(got.get("text").is_none());
}
