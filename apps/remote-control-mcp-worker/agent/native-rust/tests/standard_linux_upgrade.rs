#![cfg(target_os = "linux")]

use rca_native_agent::upgrade_control::{UpgradeCommand, UpgradeServer};
use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::mpsc::sync_channel;
use std::thread;
use std::time::Duration;

fn exchange(path: &std::path::Path, command: &str) -> String {
    let mut stream = UnixStream::connect(path).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    stream.write_all(command.as_bytes()).unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    response
}

#[test]
fn owner_local_upgrade_protocol_matches_existing_node_installer() {
    let home = tempfile::tempdir().unwrap();
    let key = home.path().join("v2-identity.pem");
    fs::set_permissions(home.path(), fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(&key, "test identity").unwrap();
    let (sender, receiver) = sync_channel(4);
    let server = UpgradeServer::bind(&key, sender).unwrap();
    let socket = home.path().join("upgrade.sock");
    assert_eq!(
        fs::symlink_metadata(&socket).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let worker = thread::spawn(move || {
        for expected in [
            UpgradeCommand::Freeze,
            UpgradeCommand::VerifyFrozen,
            UpgradeCommand::Release,
        ] {
            let request = receiver.recv_timeout(Duration::from_secs(2)).unwrap();
            assert_eq!(request.command, expected);
            request
                .reply
                .send(match expected {
                    UpgradeCommand::Release => "released\n",
                    _ => "ready\n",
                })
                .unwrap();
        }
    });
    assert_eq!(exchange(&socket, "freeze\n"), "ready\n");
    assert_eq!(exchange(&socket, "verify-frozen\n"), "ready\n");
    assert_eq!(exchange(&socket, "release\n"), "released\n");
    worker.join().unwrap();
    drop(server);
    assert!(!socket.exists());
}

#[test]
fn stale_owned_node_socket_is_recovered_without_touching_other_files() {
    let home = tempfile::tempdir().unwrap();
    fs::set_permissions(home.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let socket = home.path().join("upgrade.sock");
    let old = UnixListener::bind(&socket).unwrap();
    drop(old);
    let (sender, _receiver) = sync_channel(1);
    let server = UpgradeServer::bind(&home.path().join("v2-identity.pem"), sender).unwrap();
    assert!(socket.exists());
    drop(server);
    assert!(!socket.exists());
}

#[test]
fn live_owner_socket_is_not_replaced_and_unknown_commands_are_rejected() {
    let home = tempfile::tempdir().unwrap();
    fs::set_permissions(home.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let key = home.path().join("v2-identity.pem");
    let (sender, _receiver) = sync_channel(1);
    let server = UpgradeServer::bind(&key, sender).unwrap();
    let socket = home.path().join("upgrade.sock");
    let (other, _receiver) = sync_channel(1);
    assert!(UpgradeServer::bind(&key, other).is_err());
    assert!(exchange(&socket, "unknown\n").is_empty());
    drop(server);
    assert!(!socket.exists());
}
