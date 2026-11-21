//! Linux process/SQLite compatibility against the independent Node Agent
//! receipt contract and a disposable, actual C-supervised shell.
#![cfg(target_os = "linux")]

use rca_native_agent::linux_managed::{LinuxManagedSessions, SessionState};
use rca_native_agent::linux_supervisor::CleanupState;
use rca_native_agent::native_process::{
    execute_process_read, parse_process_mutation, parse_process_read, NativeProcessEngine,
    ProcessMutation, ProcessRead,
};
use rca_native_agent::receipts::ReceiptStore;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

fn sessions() -> Arc<LinuxManagedSessions> {
    let helper = std::env::var("RCA_NATIVE_SUPERVISOR_BIN")
        .expect("explicit C supervisor required for physical process tests");
    assert!(Path::new(&helper).is_file());
    Arc::new(
        LinuxManagedSessions::new(
            Path::new(&helper),
            Path::new("/bin/sh"),
            Duration::from_secs(10),
        )
        .unwrap(),
    )
}

fn receipt_dir() -> tempfile::TempDir {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    root
}

fn until_state(
    engine: &mut NativeProcessEngine,
    receipts: &mut ReceiptStore,
    id: &str,
    state: &str,
) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        engine.reconcile(receipts).unwrap();
        if receipts.get(id).unwrap().unwrap().state == state {
            return;
        }
        assert!(Instant::now() < deadline, "receipt did not reach {state}");
        std::thread::sleep(Duration::from_millis(15));
    }
}

#[test]
fn parses_node_process_arguments_and_rejects_protocol_smuggling() {
    let sid = "00000000-0000-4000-8000-000000000000";
    assert!(matches!(
        parse_process_mutation("start_process", &json!({"command":"printf ok"})),
        Some(ProcessMutation::Start {
            timeout_ms: 1000,
            ..
        })
    ));
    assert!(
        parse_process_mutation("start_process", &json!({"command":"😀".repeat(4097)})).is_none()
    );
    assert!(parse_process_mutation("start_process", &json!({"command":"echo \u{0}"})).is_none());
    for args in [
        json!({"command":"ok", "timeout_ms":30001}),
        json!({"command":"ok", "timeout_ms":-1}),
        json!({"command":"ok", "timeout_ms":1.2}),
        json!({"command":"ok", "extra":true}),
    ] {
        assert!(parse_process_mutation("start_process", &args).is_none());
    }
    assert!(parse_process_mutation(
        "interact_with_process",
        &json!({"session_id":sid,"input":"中😀\n"})
    )
    .is_some());
    assert!(parse_process_mutation(
        "interact_with_process",
        &json!({"session_id":sid,"input":"a".repeat(8193)})
    )
    .is_none());
    assert!(parse_process_mutation(
        "interact_with_process",
        &json!({"session_id":sid,"input":""})
    )
    .is_none());
    assert!(
        parse_process_mutation("force_terminate", &json!({"session_id":sid,"pid":123})).is_none()
    );
    assert!(
        parse_process_mutation("force_terminate", &json!({"session_id":"not-a-uuid"})).is_none()
    );
    assert!(matches!(
        parse_process_read("list_sessions", &json!({})),
        Some(ProcessRead::List)
    ));
    assert!(matches!(
        parse_process_read("list_sessions", &json!({"extra":1})),
        Some(ProcessRead::Failed)
    ));
    assert!(matches!(
        parse_process_read("read_process_output", &json!({"session_id":sid})),
        Some(ProcessRead::Output {
            offset: 0,
            length: 16384,
            ..
        })
    ));
    assert!(matches!(
        parse_process_read(
            "read_process_output",
            &json!({"session_id":sid,"length":65537})
        ),
        Some(ProcessRead::Failed)
    ));
    assert!(parse_process_read("run_command", &json!({})).is_none());
}

#[test]
#[ignore = "requires disposable Ubuntu and native C helper"]
fn digest_goldens_match_node_24_normalized_process_args() {
    let root = receipt_dir();
    let mut receipts = ReceiptStore::open(root.path()).unwrap();
    let registry = sessions();
    let mut engine = NativeProcessEngine::new(Arc::clone(&registry));
    let start = engine
        .execute(
            &mut receipts,
            "p-gold-start",
            "start_process",
            &json!({"command":"printf ok"}),
            || true,
        )
        .unwrap();
    assert_eq!(
        start.receipt.unwrap().argument_digest,
        "2e375ea53a2a26589f02b999d73d734f50d50531a8489170f040ede245da076a"
    );
    let sid = "00000000-0000-4000-8000-000000000000";
    let input = engine
        .execute(
            &mut receipts,
            "p-gold-input",
            "interact_with_process",
            &json!({"session_id":sid,"input":"中😀\n"}),
            || true,
        )
        .unwrap();
    assert_eq!(
        input.receipt.unwrap().argument_digest,
        "91d13bbfd7674d8163bf2816c4513705858a925f22e1897c3168dcac65a70554"
    );
    let stop = engine
        .execute(
            &mut receipts,
            "p-gold-stop",
            "force_terminate",
            &json!({"session_id":sid}),
            || true,
        )
        .unwrap();
    assert_eq!(
        stop.receipt.unwrap().argument_digest,
        "c00f2cfb0ed26267781d6f92441b734949f974c8afe8a2dba14469c7d8cd3420"
    );
    assert_eq!(
        registry.stop_all(Duration::from_secs(5)),
        CleanupState::Confirmed
    );
}

#[test]
#[ignore = "requires disposable Ubuntu and native C helper"]
fn start_input_exit_receipt_and_same_id_never_replay() {
    let root = receipt_dir();
    let mut receipts = ReceiptStore::open(root.path()).unwrap();
    let registry = sessions();
    let mut engine = NativeProcessEngine::new(Arc::clone(&registry));
    let args = json!({"command":"IFS= read -r v; printf '%s' \"$v\"", "timeout_ms":0});
    let start = engine
        .execute(&mut receipts, "p-start-a", "start_process", &args, || true)
        .unwrap();
    assert_eq!(start.state, "running");
    let sid = start.session_id.unwrap();
    assert_eq!(registry.list().len(), 1);
    let repeat = engine
        .execute(&mut receipts, "p-start-a", "start_process", &args, || true)
        .unwrap();
    assert_eq!(repeat.state, "running");
    assert_eq!(repeat.session_id.as_deref(), Some(sid.as_str()));
    assert_eq!(
        registry.list().len(),
        1,
        "same ID must not launch another command"
    );
    assert_eq!(
        engine
            .execute(
                &mut receipts,
                "p-start-a",
                "start_process",
                &json!({"command":"printf other","timeout_ms":0}),
                || true
            )
            .unwrap()
            .state,
        "conflict"
    );

    let input = json!({"session_id":sid,"input":"中😀\n"});
    assert_eq!(
        engine
            .execute(
                &mut receipts,
                "p-input-a",
                "interact_with_process",
                &input,
                || true
            )
            .unwrap()
            .state,
        "completed"
    );
    assert_eq!(
        engine
            .execute(
                &mut receipts,
                "p-input-a",
                "interact_with_process",
                &input,
                || true
            )
            .unwrap()
            .state,
        "completed"
    );
    assert_eq!(
        engine
            .execute(
                &mut receipts,
                "p-input-a",
                "interact_with_process",
                &json!({"session_id":sid,"input":"different\n"}),
                || true
            )
            .unwrap()
            .state,
        "conflict"
    );
    until_state(&mut engine, &mut receipts, "p-start-a", "completed");
    let read = parse_process_read("read_process_output", &json!({"session_id":sid})).unwrap();
    let wire = execute_process_read(&registry, "00000000-0000-4000-8000-000000000000", &read);
    let message: Value = serde_json::from_str(&wire).unwrap();
    assert_eq!(message["status"], "completed");
    let text: Value = serde_json::from_str(message["text"].as_str().unwrap()).unwrap();
    assert_eq!(text["output"], "中😀");
    assert_eq!(text["state"], "completed");
    assert!(text["started_at"].as_str().unwrap().ends_with('Z'));
    assert!(text["last_observed_at"].as_u64().unwrap() > 0);
    assert_eq!(
        registry.stop_all(Duration::from_secs(2)),
        CleanupState::Confirmed
    );

    drop(engine);
    drop(receipts);
    let mut restarted = ReceiptStore::open(root.path()).unwrap();
    let next_registry = sessions();
    let mut next = NativeProcessEngine::new(Arc::clone(&next_registry));
    let outcome = next
        .execute(&mut restarted, "p-start-a", "start_process", &args, || true)
        .unwrap();
    assert_eq!(outcome.state, "completed");
    assert!(
        next_registry.list().is_empty(),
        "restart replayed a persisted operation"
    );
}

#[test]
#[ignore = "requires disposable Ubuntu and native C helper"]
fn interrupted_running_receipt_recovers_unknown_without_replay() {
    let root = receipt_dir();
    let registry = sessions();
    let mut receipts = ReceiptStore::open(root.path()).unwrap();
    let mut engine = NativeProcessEngine::new(Arc::clone(&registry));
    let args = json!({"command":"sleep 30","timeout_ms":0});
    let started = engine
        .execute(&mut receipts, "p-crash-a", "start_process", &args, || true)
        .unwrap();
    assert_eq!(started.state, "running");
    assert_eq!(
        registry.stop_all(Duration::from_secs(5)),
        CleanupState::Confirmed
    );
    drop(engine);
    drop(receipts);
    let mut reopened = ReceiptStore::open(root.path()).unwrap();
    assert_eq!(reopened.get("p-crash-a").unwrap().unwrap().state, "unknown");
    let next_registry = sessions();
    let mut next = NativeProcessEngine::new(Arc::clone(&next_registry));
    let same = next
        .execute(&mut reopened, "p-crash-a", "start_process", &args, || true)
        .unwrap();
    assert_eq!(same.state, "unknown");
    assert!(next_registry.list().is_empty());
    assert_eq!(
        next.execute(
            &mut reopened,
            "p-crash-a",
            "start_process",
            &json!({"command":"printf bad","timeout_ms":0}),
            || true
        )
        .unwrap()
        .state,
        "conflict"
    );
}

#[test]
#[ignore = "requires disposable Ubuntu and native C helper"]
fn revoked_lease_cannot_launch_or_write_and_keeps_known_no_effect() {
    let root = receipt_dir();
    let mut receipts = ReceiptStore::open(root.path()).unwrap();
    let registry = sessions();
    let mut engine = NativeProcessEngine::new(Arc::clone(&registry));
    assert_eq!(
        engine
            .execute(
                &mut receipts,
                "p-revoked",
                "start_process",
                &json!({"command":"printf forbidden","timeout_ms":0}),
                || false
            )
            .unwrap()
            .state,
        "unavailable"
    );
    assert!(registry.list().is_empty());
    assert!(receipts.get("p-revoked").unwrap().is_none());
    // Revocation just after admission must also prevent launch.
    let calls = std::cell::Cell::new(0);
    let after_admission = engine
        .execute(
            &mut receipts,
            "p-revoked-after",
            "start_process",
            &json!({"command":"printf forbidden","timeout_ms":0}),
            || {
                let prior = calls.get();
                calls.set(prior + 1);
                prior == 0
            },
        )
        .unwrap();
    assert_eq!(after_admission.state, "failed");
    assert_eq!(
        receipts.get("p-revoked-after").unwrap().unwrap().state,
        "failed"
    );
    assert!(registry.list().is_empty());
    let sid = "00000000-0000-4000-8000-000000000000";
    let outcome = engine
        .execute(
            &mut receipts,
            "p-revoked-input",
            "interact_with_process",
            &json!({"session_id":sid,"input":"do not send"}),
            || false,
        )
        .unwrap();
    assert_eq!(outcome.state, "unavailable");
    assert!(receipts.get("p-revoked-input").unwrap().is_none());
    assert_eq!(registry.stop_all(Duration::ZERO), CleanupState::Confirmed);
}

#[test]
#[ignore = "requires disposable Ubuntu and native C helper"]
fn owned_terminate_waits_for_confirmed_cleanup() {
    let root = receipt_dir();
    let mut receipts = ReceiptStore::open(root.path()).unwrap();
    let registry = sessions();
    let mut engine = NativeProcessEngine::new(Arc::clone(&registry));
    let started = engine
        .execute(
            &mut receipts,
            "p-stop-start",
            "start_process",
            &json!({"command":"sleep 30","timeout_ms":0}),
            || true,
        )
        .unwrap();
    let sid = started.session_id.unwrap();
    let stopped = engine
        .execute(
            &mut receipts,
            "p-stop-op",
            "force_terminate",
            &json!({"session_id":sid}),
            || true,
        )
        .unwrap();
    assert_eq!(stopped.state, "completed");
    let ended = registry.get(&sid).unwrap();
    assert_eq!(ended.state, SessionState::Completed);
    assert_eq!(ended.cleanup, Some(CleanupState::Confirmed));
    assert_eq!(
        registry.stop_all(Duration::from_secs(1)),
        CleanupState::Confirmed
    );
}
