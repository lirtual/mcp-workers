//! Cross-implementation test through the Node Agent's public ReceiptStore seam.
//! This test requires Node 24, used only by CI/testing, never by the Rust runtime.
use rca_native_agent::receipts::{Admission, ReceiptStore};
use serde_json::json;
use std::process::Command;

fn run_node(cwd: &std::path::Path, script: &str, directory: &std::path::Path) {
    let output = Command::new("node")
        .args([
            "--experimental-strip-types",
            "--input-type=module",
            "-e",
            script,
        ])
        .arg(directory)
        .current_dir(cwd)
        .output()
        .expect("Gate 0 requires a Node 24 reference runtime");
    assert!(
        output.status.success(),
        "Node reference failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn node_receipts_are_readable_and_rust_receipts_remain_node_compatible() {
    let directory = tempfile::tempdir().unwrap();
    let agent_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let create_by_node = r#"
        import { ReceiptStore, operationDigest } from './src/operations.ts';
        const store = new ReceiptStore(process.argv[1]);
        await store.open();
        const first = { path: '/tmp/first', content: 'once' };
        const second = { path: '/tmp/unconfirmed' };
        await store.admit('node-completed','write_file',operationDigest('write_file',first));
        await store.update('node-completed','completed','Node wrote this',undefined,false);
        await store.admit('node-interrupted','delete_file',operationDigest('delete_file',second));
        await store.update('node-interrupted','running','dispatched',undefined,false);
        await store.close();
    "#;
    run_node(agent_dir, create_by_node, directory.path());

    let args = json!({"path":"/tmp/first","content":"once"});
    let mut rust = ReceiptStore::open(directory.path()).unwrap();
    assert_eq!(
        rust.get("node-completed").unwrap().unwrap().state,
        "completed"
    );
    assert_eq!(
        rust.get("node-interrupted").unwrap().unwrap().state,
        "unknown"
    );
    assert!(matches!(
        rust.admit("node-completed", "write_file", &args).unwrap(),
        Admission::Same(_)
    ));
    assert!(matches!(
        rust.admit(
            "node-completed",
            "write_file",
            &json!({"path":"/tmp/second"})
        )
        .unwrap(),
        Admission::Conflict(_)
    ));
    let rust_args = json!({"content":"rust","path":"/tmp/new"});
    assert!(matches!(
        rust.admit("rust-new", "write_file", &rust_args).unwrap(),
        Admission::New(_)
    ));
    rust.update("rust-new", "failed", "effect is unknown", None, false)
        .unwrap();
    drop(rust);

    let verify_by_node = r#"
        import { ReceiptStore, operationDigest } from './src/operations.ts';
        const store = new ReceiptStore(process.argv[1]);
        await store.open();
        const old = await store.get('node-interrupted');
        const written = await store.get('rust-new');
        if (old?.state !== 'unknown' || written?.state !== 'failed') throw Error('Node cannot read Rust records');
        const same = await store.admit('rust-new','write_file',
            operationDigest('write_file',{path:'/tmp/new',content:'rust'}));
        const clash = await store.admit('rust-new','write_file',
            operationDigest('write_file',{path:'/tmp/changed'}));
        if (same.kind !== 'same' || clash.kind !== 'conflict') throw Error('Node deduplication diverged');
        await store.close();
    "#;
    run_node(agent_dir, verify_by_node, directory.path());
}
