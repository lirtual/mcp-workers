//! Exercise the actual Rust provider child boundary with only disposable CLI shims.
//! No real provider executable, credentials or network is available to the fixture.
#![cfg(unix)]
use rca_native_agent::secure_input::{execute, parse_target, prepare};
use serde_json::json;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::process::Command;

const ACCOUNT: &str = "0123456789abcdef0123456789abcdef";
const MARKER: &str = "synthetic-provider-input-7fb2";
const GH: &str = r#"#!/bin/sh
set -eu
if [ -f "$HOME/slow" ]; then /bin/sleep 1.4; fi
case "$*" in
  'api user') printf '%s' '{"login":"fixture-owner"}' ;;
  'api repos/acme/fixture') printf '%s' '{"full_name":"acme/fixture","permissions":{"admin":true}}' ;;
  'api repos/acme/fixture/environments/integration') printf '%s' '{"name":"integration"}' ;;
  'secret set FIXTURE --repo acme/fixture'|'variable set FIXTURE --repo acme/fixture'|'secret set FIXTURE --repo acme/fixture --env integration'|'variable set FIXTURE --repo acme/fixture --env integration')
    # read must encounter EOF without a newline. Compare exact synthetic bytes.
    if IFS= read -r input; then exit 42; fi
    [ "$input" = synthetic-provider-input-7fb2 ]
    if /usr/bin/env | /usr/bin/grep -Fq synthetic-provider-input-7fb2; then exit 44; fi
    printf '%s' "$input"; printf '%s' "$input" >&2 ;;
  *) exit 43 ;;
esac
"#;
const CF: &str = r#"#!/bin/sh
set -eu
[ "${CLOUDFLARE_ACCOUNT_ID:-}" = 0123456789abcdef0123456789abcdef ]
[ "$1" = --config ]
[ "$2" = "$PWD/wrangler.json" ]
[ "$(/bin/cat "$2")" = '{"account_id":"0123456789abcdef0123456789abcdef"}' ]
shift 2
case "$*" in
  'whoami --account 0123456789abcdef0123456789abcdef --json') printf '%s' '{"user":{"email":"fixture@example.test"},"accounts":[{"id":"0123456789abcdef0123456789abcdef"}]}' ;;
  'deployments list --name fixture-integration --json'|'deployments list --name fixture --json') printf '%s' '[{"id":"fixture-deployment"}]' ;;
  'secret put FIXTURE --name fixture'|'versions secret put FIXTURE --name fixture-integration')
    if IFS= read -r input; then exit 42; fi
    [ "$input" = synthetic-provider-input-7fb2 ]
    if /usr/bin/env | /usr/bin/grep -Fq synthetic-provider-input-7fb2; then exit 44; fi
    printf '%s' "$input"; printf '%s' "$input" >&2 ;;
  *) exit 43 ;;
esac
"#;

fn run_fixture(mode: &str) {
    let dir = tempfile::tempdir().unwrap();
    for (name, script) in [("gh", GH), ("wrangler", CF)] {
        let path = dir.path().join(name);
        fs::write(&path, script).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
    }
    if mode == "slow" {
        fs::write(dir.path().join("slow"), b"").unwrap();
    }
    let result = Command::new(std::env::current_exe().unwrap())
        .args(["--ignored", "--exact", "provider_fixture", "--nocapture"])
        .env_clear()
        .env("PATH", dir.path())
        .env("HOME", dir.path())
        .env("TMPDIR", dir.path())
        .env("RCA_TEST_PROVIDER_FIXTURE", mode)
        .output()
        .unwrap();
    assert!(
        !fs::read_dir(dir.path()).unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("rca-provider-")),
        "provider configuration was not removed"
    );
    assert!(!String::from_utf8_lossy(&result.stdout).contains(MARKER));
    assert!(!String::from_utf8_lossy(&result.stderr).contains(MARKER));
    assert!(
        result.status.success(),
        "fixture {mode} failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );
}

#[test]
fn github_provider_preserves_exact_input() {
    run_fixture("github");
}

#[test]
fn cloudflare_provider_binds_account_and_preserves_input() {
    run_fixture("cloudflare");
}

#[test]
fn provider_preflight_has_one_total_deadline() {
    run_fixture("slow");
}

#[test]
#[ignore = "spawned only by the isolated provider boundary tests"]
fn provider_fixture() {
    let mode = std::env::var("RCA_TEST_PROVIDER_FIXTURE").expect("isolated fixture only");
    let root = std::path::PathBuf::from(std::env::var_os("HOME").expect("fixture HOME"));
    assert_eq!(std::env::var_os("PATH").as_deref(), Some(root.as_os_str()));
    for (name, script) in [("gh", GH), ("wrangler", CF)] {
        assert_eq!(fs::read(root.join(name)).unwrap(), script.as_bytes());
    }
    if mode == "slow" {
        let target = parse_target(&json!({"kind":"github_environment_secret","repository":"acme/fixture","environment":"integration","name":"FIXTURE"})).unwrap();
        let start = std::time::Instant::now();
        assert_eq!(prepare(&target, || false), Err("timed_out"));
        assert!(start.elapsed() < std::time::Duration::from_secs(4));
        let start = std::time::Instant::now();
        assert_eq!(
            prepare(&target, || start.elapsed()
                >= std::time::Duration::from_millis(100)),
            Err("execution_interrupted")
        );
        assert!(start.elapsed() < std::time::Duration::from_secs(1));
        return;
    }
    let targets = match mode.as_str() {
        "github" => vec![
            json!({"kind":"github_repository_secret","repository":"acme/fixture","name":"FIXTURE"}),
            json!({"kind":"github_repository_variable","repository":"acme/fixture","name":"FIXTURE"}),
            json!({"kind":"github_environment_secret","repository":"acme/fixture","environment":"integration","name":"FIXTURE"}),
            json!({"kind":"github_environment_variable","repository":"acme/fixture","environment":"integration","name":"FIXTURE"}),
        ],
        "cloudflare" => vec![
            json!({"kind":"cloudflare_worker_secret","account_id":ACCOUNT,"worker_name":"fixture","environment":"default","mode":"deploy","name":"FIXTURE"}),
            json!({"kind":"cloudflare_worker_secret","account_id":ACCOUNT,"worker_name":"fixture","environment":"integration","mode":"version","name":"FIXTURE"}),
        ],
        _ => panic!("invalid fixture mode"),
    };
    for raw in targets {
        let target = parse_target(&raw).unwrap();
        let principal = prepare(&target, || false).expect("exact target preflight must succeed");
        let lossy_suffixes: &[&str] = if mode == "cloudflare" {
            &[" ", "\n", "\u{feff}"]
        } else {
            &["\r", "\n", "\r\n"]
        };
        for ending in lossy_suffixes {
            let result = execute(&target, &principal, format!("{MARKER}{ending}"), || false);
            assert_eq!(result.status, "failed");
            assert_eq!(result.error_code, Some("input_rejected"));
        }
        let mut changed = principal.clone();
        changed["identity"] = json!("different-fixture-owner");
        let rejected = execute(&target, &changed, MARKER.to_owned(), || false);
        assert_eq!(rejected.status, "failed");
        assert_eq!(rejected.error_code, Some("target_not_accessible"));
        let outcome = execute(&target, &principal, MARKER.to_owned(), || false);
        assert_eq!(outcome.status, "succeeded", "{outcome:?}");
    }
}
