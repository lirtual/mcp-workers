//! Independent Node crypto reference for the published pairing transcript; no live pairing.
use rca_native_agent::device_pairing::{
    generate_private_pem, new_pending_enrollment, PairingClient,
};
use serde_json::{json, Value};
use std::io::Write;
use std::process::{Command, Stdio};

#[test]
fn pending_material_matches_node_for_both_grant_modes_and_retries() {
    let pem = generate_private_pem().unwrap();
    let a = new_pending_enrollment("节点 🧪", &pem, false).unwrap();
    let b = new_pending_enrollment("节点 🧪", &pem, true).unwrap();
    assert_eq!(a.request["public_key"], b.request["public_key"]);
    assert_eq!(a.fingerprint, b.fingerprint);
    assert!(a.request.get("grant_type").is_none());
    assert_eq!(b.request["grant_type"], "temporary");
    let agent = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let mut child = Command::new("node")
        .args(["--experimental-strip-types", "--input-type=module", "-e", r#"
          import {createPrivateKey,createPublicKey,createHash,sign} from 'node:crypto';
          const ENROLLMENT_DOMAIN='remote-control:v2:pending:';
          function pairingVerifier(code){
            if(!/^[A-Z2-7]{10}$/.test(code))throw Error('Invalid pairing code');
            return createHash('sha256').update(ENROLLMENT_DOMAIN+code).digest('hex');
          }
          let raw=''; for await(const x of process.stdin) raw+=x;
          const {pem,rows}=JSON.parse(raw);
          const key=createPrivateKey(pem);
          const der=createPublicKey(key).export({type:'spki',format:'der'});
          for(const {code,fingerprint,request:r} of rows){
            if(r.code_verifier!==pairingVerifier(code) ||
               r.public_key!==der.toString('base64') ||
               fingerprint!==createHash('sha256').update(der).digest('hex').slice(0,24) ||
               r.pairing_protocol!=='single-code-v1' ||
               r.proof!==sign(null,Buffer.from(ENROLLMENT_DOMAIN+r.code_verifier+':'+r.public_key+':'+r.name+':'+r.issued_at+(r.grant_type==='temporary'?':temporary':'')+':single-code-v1'),key).toString('base64'))
              process.exit(1);
            if('code' in r || 'private_key' in r)process.exit(2);
          }
          console.log(JSON.stringify({verified:true}));
        "#])
        .current_dir(agent).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(
            json!({"pem":pem,"rows":[
                {"code":a.code,"fingerprint":a.fingerprint,"request":a.request},
                {"code":b.code,"fingerprint":b.fingerprint,"request":b.request}
            ]})
            .to_string()
            .as_bytes(),
        )
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap()["verified"],
        true
    );
}

#[test]
fn bad_name_key_and_non_https_origin_are_rejected() {
    let pem = generate_private_pem().unwrap();
    for name in ["", "a\nb", &"🧪".repeat(33)] {
        assert!(new_pending_enrollment(name, &pem, false).is_err());
    }
    assert!(new_pending_enrollment("valid", "not a key", false).is_err());
    for endpoint in [
        "http://127.0.0.1:9/",
        "https://user@example.org/",
        "https://example.org/path",
        "https://example.org/?secret=x",
    ] {
        assert!(PairingClient::new(endpoint).is_err());
    }
}

#[cfg(target_os = "linux")]
#[test]
fn real_native_pair_entry_refuses_non_interactive_invocation_without_identity() {
    use std::os::unix::fs::PermissionsExt;
    let home = tempfile::tempdir().unwrap();
    std::fs::set_permissions(home.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let identity = home.path().join(".local/share/mcp-workers/remote-control");
    std::fs::create_dir_all(&identity).unwrap();
    std::fs::set_permissions(&identity, std::fs::Permissions::from_mode(0o700)).unwrap();
    for command in ["--pair-local", "--temporary-local"] {
        let output = Command::new(env!("CARGO_BIN_EXE_rca-standard-linux-candidate"))
            .args([command, "https://127.0.0.1:9/", "fixture"])
            .env_clear()
            .env("HOME", home.path())
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(std::fs::read_dir(&identity).unwrap().next().is_none());
    }
}

#[cfg(windows)]
#[test]
fn windows_native_pair_entry_refuses_non_interactive_invocation() {
    let home = tempfile::tempdir().unwrap();
    for mode in ["permanent", "temporary"] {
        let output = Command::new(env!("CARGO_BIN_EXE_rca-standard-windows-candidate"))
            .args(["--pair-local", "https://127.0.0.1:9/", "fixture", mode])
            .env("LOCALAPPDATA", home.path())
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(std::fs::read_dir(home.path()).unwrap().next().is_none());
    }
    let output = Command::new(env!("CARGO_BIN_EXE_rca-standard-windows-candidate"))
        .args(["--cli", "run", "--endpoint", "https://127.0.0.1:9/"])
        .env("LOCALAPPDATA", home.path())
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(std::fs::read_dir(home.path()).unwrap().next().is_none());
    for args in [
        vec!["--cli", "enable", "--endpoint", "https://127.0.0.1:9/"],
        vec!["--cli", "onboard", "--endpoint", "https://127.0.0.1:9/"],
        vec!["--cli", "upgrade", "--version", "v0.1.59-rust-candidate.1"],
        vec!["--cli", "recover"],
        vec!["--cli", "stop"],
        vec!["--cli", "start"],
        vec!["--cli", "disable"],
        vec!["--cli", "re-pair", "--endpoint", "https://127.0.0.1:9/"],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_rca-standard-windows-candidate"))
            .args(args)
            .env("LOCALAPPDATA", home.path())
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(std::fs::read_dir(home.path()).unwrap().next().is_none());
    }
}
