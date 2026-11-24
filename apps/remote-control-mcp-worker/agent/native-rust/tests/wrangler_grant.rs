//! Opt-in integration against an actual disposable local Wrangler/SQLite DO.
//! Requires a separately paired temporary test identity; never targets production.
use rca_native_agent::session::{connect_authenticated, HeartbeatTiming, SessionError};
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::Duration;

#[test]
#[ignore = "run only with disposable local Wrangler at 127.0.0.1:8777 and paired temporary test identity"]
fn real_worker_authorizes_periodic_probe_then_rejects_revoked_identity() {
    let root =
        std::env::var("RCA_LOCAL_GATE1_ROOT").expect("explicit disposable test root required");
    let root = Path::new(&root);
    assert!(
        root.parent() == Some(Path::new("/tmp"))
            && root
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with("rca-gate1-local-")),
        "only an explicit disposable local gate1 root is accepted"
    );
    let pem = fs::read_to_string(root.join("gate1-test-key.pem")).unwrap();
    let device_id = fs::read_to_string(root.join("device-id")).unwrap();
    let device_id = device_id.trim();
    let endpoint = "http://127.0.0.1:8777/";
    let mut socket = connect_authenticated(endpoint, &pem, device_id).unwrap();
    socket
        .set_heartbeat_timing(HeartbeatTiming {
            // Local Wrangler may not emulate the DO hibernation ping auto-response;
            // the signed pong path is covered by the loopback contract tests.
            interval: Duration::from_secs(60),
            timeout: Duration::from_secs(2),
            // The real DO rate-gates probes for 30s after WS admission.
            auth_interval: Duration::from_secs(31),
        })
        .unwrap();
    let (requests_tx, requests_rx) = mpsc::sync_channel(2);
    let (_answers_tx, mut answers_rx) = tokio::sync::mpsc::channel(4);
    let stop = Arc::new(AtomicBool::new(false));
    let running = Arc::new(AtomicBool::new(true));
    let notifier = Arc::clone(&running);
    thread::spawn(move || {
        // A live pump past the first 31s auth probe plus its 2s timeout
        // demonstrates that the DO accepted the exact signed Grant nonce.
        thread::sleep(Duration::from_secs(34));
        if notifier.load(Ordering::Acquire) {
            println!("AUTH_PROBE_PASSED: request local Owner revoke now");
        }
    });
    let result = socket.pump(&stop, &requests_tx, &mut answers_rx);
    running.store(false, Ordering::Release);
    assert!(
        matches!(result, Err(SessionError::Policy)),
        "expected real Owner 1008"
    );
    assert!(
        requests_rx.try_recv().is_err(),
        "cleanup must not dispatch as a normal operation"
    );
    assert!(
        matches!(
            connect_authenticated(endpoint, &pem, device_id),
            Err(SessionError::Rejected(401 | 403 | 404))
        ),
        "revoked disposable identity must fail a fresh challenge"
    );
    println!("REAL_WORKER_REVOKE_AND_RECONNECT_REJECTION_PASSED");
}
