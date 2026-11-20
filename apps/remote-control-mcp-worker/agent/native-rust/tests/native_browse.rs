use rca_native_agent::native_read::{execute_read_frame, parse_read_frame, ReadFrameError};
use serde_json::{json, Value};
use std::fs;
use tempfile::tempdir;

const REQUEST_ID: &str = "99999999-aaaa-4bbb-8ccc-dddddddddddd";

fn call(tool: &str, arguments: Value) -> Value {
    let request = json!({"kind":"read","request_id":REQUEST_ID,
        "tool":tool,"arguments":arguments})
    .to_string();
    let command = parse_read_frame(&request).expect("known read tool must have a valid envelope");
    serde_json::from_str(&execute_read_frame(&command)).unwrap()
}

#[test]
fn multiple_files_matches_node_block_contract_and_isolates_file_failures() {
    let dir = tempdir().unwrap();
    let first = dir.path().join("first.txt");
    let second = dir.path().join("second.txt");
    fs::write(&first, b"hello\r\nworld\n").unwrap();
    fs::write(&second, b"two\n").unwrap();
    let missing = dir.path().join("missing");
    let got = call(
        "read_multiple_files",
        json!({"paths":[first,missing,second]}),
    );
    assert_eq!(got["status"], "completed");
    assert_eq!(got["text"],
        "# file 1\nstatus: ok\nhello\nworld\n# file 2\nstatus: failed\nmessage: The file read failed.\n# file 3\nstatus: ok\ntwo\ntruncated: false");
}

#[test]
fn list_directory_matches_node_order_depth_and_non_following_symlinks() {
    let dir = tempdir().unwrap();
    fs::create_dir(dir.path().join("adir")).unwrap();
    fs::create_dir(dir.path().join("adir").join("nested")).unwrap();
    fs::write(dir.path().join("adir").join("child"), "x").unwrap();
    fs::write(dir.path().join("b.txt"), "b").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(dir.path().join("adir"), dir.path().join("c-link")).unwrap();
    let path = dir.path();
    let shallow = call("list_directory", json!({"path":path}));
    assert_eq!(shallow["status"], "completed");
    let shallow_text = shallow["text"].as_str().unwrap();
    assert!(shallow_text.starts_with("depth: 1\ntruncated: false\ndirectory adir\nfile b.txt"));
    assert!(!shallow_text.contains("adir/child"));
    let deep = call("list_directory", json!({"path":path,"depth":3}));
    assert_eq!(deep["status"], "completed");
    assert!(deep["text"].as_str().unwrap().contains("file adir/child"));
    assert!(deep["text"]
        .as_str()
        .unwrap()
        .contains("directory adir/nested"));
    #[cfg(unix)]
    {
        assert!(deep["text"].as_str().unwrap().contains("symlink c-link"));
        assert!(!deep["text"].as_str().unwrap().contains("c-link/child"));
        let denied = call("list_directory", json!({"path":path.join("c-link")}));
        assert_eq!(
            denied["status"], "failed",
            "root symlink is not a directory"
        );
    }
}

#[test]
fn directory_entries_cap_to_100_and_report_truncation() {
    let dir = tempdir().unwrap();
    for i in 0..101 {
        fs::write(dir.path().join(format!("file-{i:03}")), b"x").unwrap();
    }
    let result = call("list_directory", json!({"path":dir.path()}));
    assert_eq!(result["status"], "completed");
    let body = result["text"].as_str().unwrap();
    assert!(body.starts_with("depth: 1\ntruncated: true\nfile file-000"));
    assert!(body.contains("file file-099"));
    assert!(!body.contains("file-100"));
    assert_eq!(body.lines().count(), 102);
}

#[test]
fn file_info_uses_lstat_and_never_follows_symlink() {
    let dir = tempdir().unwrap();
    let file = dir.path().join("data");
    fs::write(&file, "hello").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&file, fs::Permissions::from_mode(0o640)).unwrap();
    }
    let data = call("get_file_info", json!({"path":file}));
    assert_eq!(data["status"], "completed");
    let text = data["text"].as_str().unwrap();
    assert!(text.starts_with("type: file\nsize: 5\n"));
    #[cfg(unix)]
    assert!(text.contains("\nmode: 640\n"));
    assert!(text.contains("\nmtime_ms: "));
    let dir_info = call("get_file_info", json!({"path":dir.path()}));
    assert!(dir_info["text"]
        .as_str()
        .unwrap()
        .starts_with("type: directory\n"));
    #[cfg(unix)]
    {
        let link = dir.path().join("alias");
        std::os::unix::fs::symlink(&file, &link).unwrap();
        let result = call("get_file_info", json!({"path":link}));
        assert!(result["text"]
            .as_str()
            .unwrap()
            .starts_with("type: symlink\n"));
    }
}

#[test]
fn supported_tool_invalid_arguments_fail_without_fs_access_and_mutations_remain_policy() {
    let invalid = [
        ("read_multiple_files", json!({"paths":[]})),
        ("read_multiple_files", json!({"paths":vec!["/tmp";9]})),
        ("read_multiple_files", json!({"paths":["file:///tmp/a"]})),
        ("read_multiple_files", json!({"paths":["/x"],"extra":true})),
        ("list_directory", json!({"path":"/tmp","depth":0})),
        ("list_directory", json!({"path":"/tmp","depth":4})),
        ("list_directory", json!({"path":"/tmp","depth":2.5})),
        (
            "list_directory",
            json!({"path":"/tmp","depth":3,"extra":true}),
        ),
        ("get_file_info", json!({"path":"//host/x"})),
        ("get_file_info", json!({"path":"/tmp","mode":"write"})),
    ];
    for (tool, args) in invalid {
        let got = call(tool, args);
        assert_eq!(got["status"], "failed", "{tool}");
        assert!(got.get("text").is_none());
    }
    let request = json!({"kind":"read","request_id":REQUEST_ID,
        "tool":"write_file","arguments":{"path":"/tmp/ignored","content":"danger"}})
    .to_string();
    assert!(matches!(
        parse_read_frame(&request),
        Err(ReadFrameError::Policy)
    ));
}

#[test]
fn oversized_browse_frame_fails_without_partial_content() {
    let dir = tempdir().unwrap();
    let file = dir.path().join("large");
    fs::write(&file, "x".repeat(66_000)).unwrap();
    let out = call("read_multiple_files", json!({"paths":[file]}));
    assert_eq!(out["status"], "failed");
    assert_eq!(out["error"], "result_too_large");
    assert!(out.get("text").is_none());
}
