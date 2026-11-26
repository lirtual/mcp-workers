//! Dedicated, metadata-only provider preparation and secret stdin path.
//! Secure input never enters the generic operation/receipt executor.
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use zeroize::Zeroize;

const MAX_SECRET_BYTES: usize = 8_192;

#[derive(Clone, Debug)]
pub enum SecureInputTarget {
    TaskProcess {
        session_id: String,
        name: String,
    },
    GitHub {
        repository: String,
        environment: Option<String>,
        name: String,
        variable: bool,
    },
    Cloudflare {
        account_id: String,
        worker_name: String,
        environment: String,
        mode: String,
        name: String,
    },
}

fn exact(value: &Value, keys: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|map| map.len() == keys.len() && keys.iter().all(|key| map.contains_key(*key)))
}

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn valid_key_name(value: &str) -> bool {
    let b = value.as_bytes();
    !b.is_empty()
        && b.len() <= 100
        && (b[0].is_ascii_uppercase() || b[0] == b'_')
        && b.iter()
            .all(|v| v.is_ascii_uppercase() || v.is_ascii_digit() || *v == b'_')
}

fn valid_repository(value: &str) -> bool {
    let mut parts = value.split('/');
    let owner = parts.next().unwrap_or_default();
    let repo = parts.next().unwrap_or_default();
    parts.next().is_none()
        && !owner.is_empty()
        && owner.len() <= 100
        && !repo.is_empty()
        && repo.len() <= 100
        && !value.contains("..")
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-/".contains(&b))
}

fn valid_environment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
}

pub fn parse_target(value: &Value) -> Option<SecureInputTarget> {
    let kind = text(value, "kind")?;
    match kind.as_str() {
        "task_process" if exact(value, &["kind", "session_id", "name"]) => {
            let session_id = text(value, "session_id")?;
            let name = text(value, "name")?;
            (crate::identity::valid_device_id(&session_id) && valid_key_name(&name))
                .then_some(SecureInputTarget::TaskProcess { session_id, name })
        }
        "github_repository_secret" | "github_repository_variable"
            if exact(value, &["kind", "repository", "name"]) =>
        {
            let repository = text(value, "repository")?;
            let name = text(value, "name")?;
            (valid_repository(&repository) && valid_key_name(&name)).then_some(
                SecureInputTarget::GitHub {
                    repository,
                    environment: None,
                    name,
                    variable: kind.ends_with("_variable"),
                },
            )
        }
        "github_environment_secret" | "github_environment_variable"
            if exact(value, &["kind", "repository", "environment", "name"]) =>
        {
            let repository = text(value, "repository")?;
            let environment = text(value, "environment")?;
            let name = text(value, "name")?;
            (valid_repository(&repository)
                && valid_environment(&environment)
                && valid_key_name(&name))
            .then_some(SecureInputTarget::GitHub {
                repository,
                environment: Some(environment),
                name,
                variable: kind.ends_with("_variable"),
            })
        }
        "cloudflare_worker_secret"
            if exact(
                value,
                &[
                    "kind",
                    "account_id",
                    "worker_name",
                    "environment",
                    "mode",
                    "name",
                ],
            ) =>
        {
            let account_id = text(value, "account_id")?;
            let worker_name = text(value, "worker_name")?;
            let environment = text(value, "environment")?;
            let mode = text(value, "mode")?;
            let name = text(value, "name")?;
            let valid_account = account_id.len() == 32
                && account_id
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
            let valid_worker = !worker_name.is_empty()
                && worker_name.len() <= 63
                && worker_name
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                && worker_name.as_bytes()[0].is_ascii_alphanumeric();
            let valid_env = environment == "default" || valid_environment(&environment);
            (valid_account
                && valid_worker
                && valid_env
                && matches!(mode.as_str(), "deploy" | "version")
                && valid_key_name(&name))
            .then_some(SecureInputTarget::Cloudflare {
                account_id,
                worker_name,
                environment,
                mode,
                name,
            })
        }
        _ => None,
    }
}

pub fn valid_secret(secret: &str) -> bool {
    !secret.trim().is_empty() && !secret.contains('\0') && secret.len() <= MAX_SECRET_BYTES
}

fn principal_matches(target: &SecureInputTarget, principal: &Value) -> bool {
    match target {
        SecureInputTarget::TaskProcess { .. } => principal.is_null(),
        SecureInputTarget::GitHub { repository, .. } => {
            exact(
                principal,
                &["provider", "identity", "repository", "permission"],
            ) && principal["provider"] == "github"
                && principal["repository"].as_str() == Some(repository.as_str())
                && principal["permission"] == "admin"
                && principal["identity"]
                    .as_str()
                    .is_some_and(|v| !v.is_empty())
        }
        SecureInputTarget::Cloudflare { account_id, .. } => {
            let fields_ok = exact(principal, &["provider", "identity", "account_id"])
                || exact(
                    principal,
                    &["provider", "identity", "account_id", "account_name"],
                );
            fields_ok
                && principal["provider"] == "cloudflare"
                && principal["account_id"].as_str() == Some(account_id.as_str())
                && principal["identity"]
                    .as_str()
                    .is_some_and(|v| !v.is_empty())
                && principal.get("account_name").is_none_or(Value::is_string)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_exact_supported_targets() {
        let target =
            json!({"kind":"github_repository_secret","repository":"owner/repo","name":"API_TOKEN"});
        assert!(matches!(
            parse_target(&target),
            Some(SecureInputTarget::GitHub { .. })
        ));
        assert!(parse_target(
            &json!({"kind":"github_repository_secret","repository":"owner/repo","name":"token"})
        )
        .is_none());
        assert!(parse_target(
            &json!({"kind":"github_repository_secret","repository":"owner/../repo","name":"TOKEN"})
        )
        .is_none());
        assert!(
            parse_target(&json!({"kind":"task_process","session_id":"bad","name":"TOKEN"}))
                .is_none()
        );
    }

    #[test]
    fn secret_validation_is_bounded_and_rejects_control_nul() {
        assert!(valid_secret("secret"));
        assert!(!valid_secret("   "));
        assert!(!valid_secret("a\0b"));
        assert!(!valid_secret(&"x".repeat(MAX_SECRET_BYTES + 1)));
    }

    #[test]
    fn provider_principal_must_match_target_and_admin_scope() {
        let target = parse_target(
            &json!({"kind":"github_repository_secret","repository":"owner/repo","name":"TOKEN"}),
        )
        .unwrap();
        let principal = json!({"provider":"github","identity":"owner","repository":"owner/repo","permission":"admin"});
        assert!(principal_matches(&target, &principal));
        let weaker = json!({"provider":"github","identity":"owner","repository":"owner/repo","permission":"write"});
        assert!(!principal_matches(&target, &weaker));
    }
}

#[derive(Debug)]
pub struct ProviderOutcome {
    pub status: &'static str,
    pub error_code: Option<&'static str>,
}

fn command_env(command: &mut std::process::Command, provider: &str, account: Option<&str>) {
    command
        .env_clear()
        .env("CI", "1")
        .env("WRANGLER_SEND_METRICS", "false");
    let keys: &[&str] = if provider == "github" {
        &[
            "PATH",
            "HOME",
            "USERPROFILE",
            "APPDATA",
            "LOCALAPPDATA",
            "SYSTEMROOT",
            "TMP",
            "TEMP",
            "XDG_CONFIG_HOME",
            "GH_TOKEN",
            "GITHUB_TOKEN",
            "GH_ENTERPRISE_TOKEN",
            "GH_HOST",
            "GH_CONFIG_DIR",
        ]
    } else {
        &[
            "PATH",
            "HOME",
            "USERPROFILE",
            "APPDATA",
            "LOCALAPPDATA",
            "SYSTEMROOT",
            "TMP",
            "TEMP",
            "XDG_CONFIG_HOME",
            "CLOUDFLARE_API_TOKEN",
            "CLOUDFLARE_API_KEY",
            "CLOUDFLARE_EMAIL",
            "WRANGLER_HOME",
            "NODE_ENV",
        ]
    };
    for key in keys {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    if let Some(account) = account {
        command.env("CLOUDFLARE_ACCOUNT_ID", account);
    }
}

fn run_cli(
    provider: &str,
    args: &[String],
    secret: Option<&mut String>,
    timeout: Duration,
    capture: bool,
    account: Option<&str>,
    cancelled: Option<&dyn Fn() -> bool>,
) -> Result<(bool, String), &'static str> {
    use std::io::{Read, Write};
    use std::process::{Command, Stdio};
    let program = if provider == "github" {
        "gh"
    } else {
        "wrangler"
    };
    let mut command = Command::new(program);
    command.args(args);
    command_env(&mut command, provider, account);
    command.stdin(if secret.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    command.stdout(if capture {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    command.stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|_| "provider_cli_unavailable")?;
    let reader = if capture {
        child.stdout.take().map(|mut pipe| {
            std::thread::spawn(move || {
                let mut bytes = Vec::new();
                let _ = (&mut pipe).take(32_769).read_to_end(&mut bytes);
                bytes
            })
        })
    } else {
        None
    };
    if let Some(value) = secret {
        // Closing stdin supplies EOF; do not append bytes to an opaque input value.
        let write_result =
            child
                .stdin
                .take()
                .ok_or("execution_interrupted")
                .and_then(|mut pipe| {
                    pipe.write_all(value.as_bytes())
                        .map_err(|_| "execution_interrupted")
                });
        value.zeroize();
        if let Err(code) = write_result {
            #[cfg(unix)]
            unsafe {
                let _ = libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            let _ = child.kill();
            let _ = child.wait();
            if let Some(reader) = reader {
                let _ = reader.join();
            }
            return Err(code);
        }
    }
    let deadline = Instant::now() + timeout;
    let status = loop {
        if cancelled.is_some_and(|check| check()) {
            #[cfg(unix)]
            unsafe {
                let _ = libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            let _ = child.kill();
            let _ = child.wait();
            if let Some(reader) = reader {
                let _ = reader.join();
            }
            return Err("execution_interrupted");
        }
        match child.try_wait().map_err(|_| "execution_interrupted")? {
            Some(status) => break status,
            None if Instant::now() >= deadline => {
                #[cfg(unix)]
                unsafe {
                    let _ = libc::kill(-(child.id() as i32), libc::SIGKILL);
                }
                let _ = child.kill();
                let _ = child.wait();
                if let Some(reader) = reader {
                    let _ = reader.join();
                }
                return Err("timed_out");
            }
            None => std::thread::sleep(Duration::from_millis(50)),
        }
    };
    let stdout = match reader {
        Some(reader) => String::from_utf8(reader.join().map_err(|_| "provider_auth_unavailable")?)
            .map_err(|_| "provider_auth_unavailable")?,
        None => String::new(),
    };
    if stdout.len() > 32_768 {
        return Err("provider_auth_unavailable");
    }
    Ok((status.success(), stdout))
}

fn parse_json_object(output: &str) -> Option<Value> {
    let value: Value = serde_json::from_str(output).ok()?;
    value.as_object()?;
    Some(value)
}

// Leave response/transport headroom within the coordinator's four-second wait.
const PREFLIGHT_BUDGET: Duration = Duration::from_millis(3_500);

fn provider_principal(
    target: &SecureInputTarget,
    cancelled: &dyn Fn() -> bool,
) -> Result<Value, &'static str> {
    let deadline = Instant::now() + PREFLIGHT_BUDGET;
    let read = |provider: &str, args: &[String], account: Option<&str>| {
        if cancelled() {
            return Err("execution_interrupted");
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("timed_out");
        }
        let result = run_cli(
            provider,
            args,
            None,
            remaining,
            true,
            account,
            Some(cancelled),
        )?;
        if Instant::now() >= deadline {
            return Err("timed_out");
        }
        Ok(result)
    };
    match target {
        SecureInputTarget::TaskProcess { .. } => Ok(Value::Null),
        SecureInputTarget::GitHub {
            repository,
            environment,
            ..
        } => {
            let (ok, out) = read("github", &["api".into(), "user".into()], None)?;
            if !ok {
                return Err("provider_auth_unavailable");
            }
            let user = parse_json_object(&out).ok_or("provider_auth_unavailable")?;
            let identity = user["login"]
                .as_str()
                .filter(|v| !v.is_empty())
                .ok_or("provider_auth_unavailable")?;
            let (ok, out) = read(
                "github",
                &["api".into(), format!("repos/{repository}")],
                None,
            )?;
            if !ok {
                return Err("target_not_accessible");
            }
            let repo = parse_json_object(&out).ok_or("target_not_accessible")?;
            if repo["full_name"]
                .as_str()
                .is_none_or(|v| !v.eq_ignore_ascii_case(repository))
                || repo["permissions"]["admin"] != true
            {
                return Err("target_not_accessible");
            }
            if let Some(env) = environment {
                let encoded =
                    url::form_urlencoded::byte_serialize(env.as_bytes()).collect::<String>();
                let route = format!("repos/{repository}/environments/{encoded}");
                let (ok, out) = read("github", &["api".into(), route], None)?;
                if !ok
                    || parse_json_object(&out)
                        .and_then(|v| v["name"].as_str().map(str::to_owned))
                        .is_none_or(|v| !v.eq_ignore_ascii_case(env))
                {
                    return Err("target_not_accessible");
                }
            }
            Ok(
                json!({"provider":"github","identity":identity,"repository":repository,"permission":"admin"}),
            )
        }
        SecureInputTarget::Cloudflare {
            account_id,
            worker_name,
            environment,
            ..
        } => {
            let args = vec![
                "whoami".into(),
                "--account".into(),
                account_id.clone(),
                "--json".into(),
            ];
            let (ok, out) = read("cloudflare", &args, Some(account_id))?;
            if !ok {
                return Err("provider_auth_unavailable");
            }
            let who = parse_json_object(&out).ok_or("provider_auth_unavailable")?;
            let user = who.get("user").filter(|v| v.is_object()).unwrap_or(&who);
            let identity = user["email"]
                .as_str()
                .filter(|v| !v.is_empty())
                .ok_or("provider_auth_unavailable")?;
            let accounts = who["accounts"]
                .as_array()
                .ok_or("provider_auth_unavailable")?;
            let account = accounts
                .iter()
                .find(|v| v["id"].as_str() == Some(account_id.as_str()))
                .ok_or("target_not_accessible")?;
            let mut args = vec![
                "deployments".into(),
                "list".into(),
                "--name".into(),
                worker_name.clone(),
                "--json".into(),
            ];
            if environment != "default" {
                args.extend(["--env".into(), environment.clone()]);
            }
            let (ok, out) = read("cloudflare", &args, Some(account_id))?;
            if !ok {
                return Err("target_not_accessible");
            }
            let data: Value = serde_json::from_str(&out).map_err(|_| "target_not_accessible")?;
            let deployments = data
                .as_array()
                .or_else(|| data["deployments"].as_array())
                .filter(|v| !v.is_empty())
                .ok_or("target_not_accessible")?;
            let _ = deployments;
            let mut principal =
                json!({"provider":"cloudflare","identity":identity,"account_id":account_id});
            if let Some(name) = account["name"].as_str() {
                principal["account_name"] = json!(name);
            }
            Ok(principal)
        }
    }
}

pub fn prepare(
    target: &SecureInputTarget,
    cancelled: impl Fn() -> bool,
) -> Result<Value, &'static str> {
    provider_principal(target, &cancelled)
}

pub fn execute(
    target: &SecureInputTarget,
    expected: &Value,
    mut secret: String,
    cancelled: impl Fn() -> bool,
) -> ProviderOutcome {
    if cancelled() {
        secret.zeroize();
        return ProviderOutcome {
            status: "unknown",
            error_code: Some("execution_interrupted"),
        };
    }
    if !valid_secret(&secret) {
        secret.zeroize();
        return ProviderOutcome {
            status: "failed",
            error_code: Some("input_rejected"),
        };
    }
    let actual = match provider_principal(target, &cancelled) {
        Ok(value) => value,
        Err(code) => {
            secret.zeroize();
            return ProviderOutcome {
                status: "failed",
                error_code: Some(code),
            };
        }
    };
    if cancelled() {
        secret.zeroize();
        return ProviderOutcome {
            status: "unknown",
            error_code: Some("execution_interrupted"),
        };
    }
    if !principal_matches(target, expected) || actual != *expected {
        secret.zeroize();
        return ProviderOutcome {
            status: "failed",
            error_code: Some("target_not_accessible"),
        };
    }
    let (provider, args, account) = match target {
        SecureInputTarget::GitHub {
            repository,
            environment,
            name,
            variable,
        } => {
            let mut args = vec![
                if *variable { "variable" } else { "secret" }.into(),
                "set".into(),
                name.clone(),
                "--repo".into(),
                repository.clone(),
            ];
            if let Some(env) = environment {
                args.extend(["--env".into(), env.clone()]);
            }
            ("github", args, None)
        }
        SecureInputTarget::Cloudflare {
            account_id,
            worker_name,
            environment,
            mode,
            name,
        } => {
            let mut args = if mode == "deploy" {
                vec![
                    "secret".into(),
                    "put".into(),
                    name.clone(),
                    "--name".into(),
                    worker_name.clone(),
                ]
            } else {
                vec![
                    "versions".into(),
                    "secret".into(),
                    "put".into(),
                    name.clone(),
                    "--name".into(),
                    worker_name.clone(),
                ]
            };
            if environment != "default" {
                args.extend(["--env".into(), environment.clone()]);
            }
            ("cloudflare", args, Some(account_id.as_str()))
        }
        SecureInputTarget::TaskProcess { .. } => {
            secret.zeroize();
            return ProviderOutcome {
                status: "failed",
                error_code: Some("input_rejected"),
            };
        }
    };
    let result = run_cli(
        provider,
        &args,
        Some(&mut secret),
        Duration::from_secs(60),
        false,
        account,
        Some(&cancelled),
    );
    secret.zeroize();
    match result {
        Ok((true, _)) => ProviderOutcome {
            status: "succeeded",
            error_code: None,
        },
        Ok((false, _)) => ProviderOutcome {
            status: "unknown",
            error_code: Some("provider_write_failed"),
        },
        Err("provider_cli_unavailable") => ProviderOutcome {
            status: "failed",
            error_code: Some("provider_cli_unavailable"),
        },
        Err(code) => ProviderOutcome {
            status: "unknown",
            error_code: Some(code),
        },
    }
}

#[derive(Debug)]
pub enum SecureInputCommand {
    Prepare {
        id: String,
        target: SecureInputTarget,
    },
    Submit {
        id: String,
        target: SecureInputTarget,
        principal: Value,
        secret: String,
    },
}

impl Drop for SecureInputCommand {
    fn drop(&mut self) {
        if let Self::Submit { secret, .. } = self {
            secret.zeroize();
        }
    }
}

/// Returns None for unrelated WSS frames and rejects malformed secure-input
/// frames before they can enter the generic operation queue.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidSecureInputFrame;

impl From<()> for InvalidSecureInputFrame {
    fn from(_: ()) -> Self {
        Self
    }
}

pub fn parse_command(frame: &str) -> Result<Option<SecureInputCommand>, InvalidSecureInputFrame> {
    if frame.len() > 65_536 {
        return Err(().into());
    }
    let value: Value = serde_json::from_str(frame).map_err(|_| ())?;
    let object = value.as_object().ok_or(())?;
    match object.get("kind").and_then(Value::as_str).ok_or(())? {
        "secure_input_prepare" => {
            if object.len() != 3 {
                return Err(().into());
            }
            let id = object
                .get("preflight_id")
                .and_then(Value::as_str)
                .ok_or(())?;
            let target = parse_target(object.get("target").ok_or(())?).ok_or(())?;
            if !crate::identity::valid_device_id(id) {
                return Err(().into());
            }
            Ok(Some(SecureInputCommand::Prepare {
                id: id.to_owned(),
                target,
            }))
        }
        "secure_input" => {
            if object.len() != 5 {
                return Err(().into());
            }
            let id = object.get("request_id").and_then(Value::as_str).ok_or(())?;
            let target = parse_target(object.get("target").ok_or(())?).ok_or(())?;
            let principal = object.get("provider_principal").ok_or(())?.clone();
            let secret = object.get("secret").and_then(Value::as_str).ok_or(())?;
            if !crate::identity::valid_device_id(id) || !valid_secret(secret) {
                return Err(().into());
            }
            Ok(Some(SecureInputCommand::Submit {
                id: id.to_owned(),
                target,
                principal,
                secret: secret.to_owned(),
            }))
        }
        _ => Ok(None),
    }
}

#[cfg(test)]
mod protocol_tests {
    use super::*;

    #[test]
    fn dedicated_frames_parse_strictly_and_generic_frames_are_not_secure_input() {
        let prepare = json!({
            "kind":"secure_input_prepare",
            "preflight_id":"12345678-1234-1234-1234-123456789abc",
            "target":{"kind":"github_repository_secret","repository":"owner/repo","name":"TOKEN"}
        })
        .to_string();
        assert!(matches!(
            parse_command(&prepare).unwrap(),
            Some(SecureInputCommand::Prepare { .. })
        ));

        let submit = json!({
            "kind":"secure_input",
            "request_id":"12345678-1234-1234-1234-123456789abc",
            "target":{"kind":"github_repository_secret","repository":"owner/repo","name":"TOKEN"},
            "provider_principal":{"provider":"github","identity":"owner","repository":"owner/repo","permission":"admin"},
            "secret":"synthetic-secret"
        }).to_string();
        assert!(matches!(
            parse_command(&submit).unwrap(),
            Some(SecureInputCommand::Submit { .. })
        ));

        assert!(parse_command(r#"{"kind":"operation","operation_id":"x"}"#)
            .unwrap()
            .is_none());
        assert!(parse_command(r#"{"kind":"secure_input","request_id":"bad"}"#).is_err());
    }
}
