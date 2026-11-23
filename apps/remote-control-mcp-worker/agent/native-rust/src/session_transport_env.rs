//! Credential-free environment for the future GitHub-hosted Session transport.
//! The one-shot OIDC registration process must not pass inherited secrets to
//! the long-lived, Shell-capable Agent process.
use std::collections::BTreeMap;
use std::process::Command;

// Exact existing Node Session allowlist. RUNNER_TRACKING_ID preserves GitHub
// job-exit cleanup; arbitrary OIDC, GH_TOKEN and process injection are excluded.
const TRANSPORT_KEYS: &[&str] = &[
    "GITHUB_ACTIONS",
    "RUNNER_ENVIRONMENT",
    "GITHUB_WORKFLOW",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
    "GITHUB_REPOSITORY",
    "ATTEMPT_ID",
    "RUNNER_TEMP",
    "RUNNER_TRACKING_ID",
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "HOMEDRIVE",
    "HOMEPATH",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "PROCESSOR_ARCHITECTURE",
    "NUMBER_OF_PROCESSORS",
];

/// Reproduce Node's exact-key-first, case-insensitive alias fallback so a
/// Windows Runner cannot hide a needed host variable behind uppercase aliases.
pub fn session_transport_environment(
    source: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    let mut clean = BTreeMap::new();
    for key in TRANSPORT_KEYS {
        let value = source.get(*key).or_else(|| {
            source
                .iter()
                .find(|(name, _)| name.eq_ignore_ascii_case(key))
                .map(|(_, value)| value)
        });
        if let Some(value) = value {
            clean.insert((*key).to_owned(), value.clone());
        }
    }

    // Keep the existing reviewed Ubuntu Session Shell loader only. Its path is
    // not a credential, but it must never be attacker-selected BASH_ENV.
    if source.get("GITHUB_ACTIONS").map(String::as_str) == Some("true")
        && source.get("GITHUB_WORKFLOW").map(String::as_str) == Some("ubuntu")
        && source.get("GITHUB_REPOSITORY").map(String::as_str) == Some("autoactions/github-actions")
        && source.get("SESSION_ACTION_RCA").map(String::as_str) == Some("1")
    {
        if let Some(home) = source.get("HOME").filter(|home| home.starts_with('/')) {
            let expected = format!("{home}/.config/session-actions/rca-env.bash");
            if source
                .get("BASH_ENV")
                .is_some_and(|value| value == &expected)
            {
                clean.insert("SESSION_ACTION_RCA".into(), "1".into());
                clean.insert("BASH_ENV".into(), expected);
            }
        }
    }
    clean
}

/// The caller supplies a *new* child Command; clear all inherited variables
/// before applying the reviewed allowlist. Never spawn through a shell.
pub fn apply_transport_environment(command: &mut Command, source: &BTreeMap<String, String>) {
    command.env_clear();
    command.envs(session_transport_environment(source));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_transport_allowlist_drops_oidc_and_cli_credentials() {
        let source = BTreeMap::from([
            ("GITHUB_ACTIONS".into(), "true".into()),
            ("RUNNER_ENVIRONMENT".into(), "github-hosted".into()),
            ("GITHUB_WORKFLOW".into(), "windows".into()),
            (
                "GITHUB_REPOSITORY".into(),
                "autoactions/github-actions".into(),
            ),
            (
                "ATTEMPT_ID".into(),
                "123e4567-e89b-42d3-a456-426614174001".into(),
            ),
            ("RUNNER_TEMP".into(), "C:\\runner\\temp".into()),
            ("RUNNER_TRACKING_ID".into(), "job-1".into()),
            (
                "ACTIONS_ID_TOKEN_REQUEST_URL".into(),
                "https://oidc.invalid".into(),
            ),
            ("ACTIONS_ID_TOKEN_REQUEST_TOKEN".into(), "one-time".into()),
            ("WORKFLOW_ACTION_OIDC_AUDIENCE".into(), "audience".into()),
            ("GH_TOKEN".into(), "gh-secret".into()),
            ("SESSION_RCA_AGENT".into(), "rust-candidate".into()),
        ]);
        let clean = session_transport_environment(&source);
        assert_eq!(
            clean.get("RUNNER_TRACKING_ID").map(String::as_str),
            Some("job-1")
        );
        for key in [
            "ACTIONS_ID_TOKEN_REQUEST_URL",
            "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
            "WORKFLOW_ACTION_OIDC_AUDIENCE",
            "GH_TOKEN",
            "SESSION_RCA_AGENT",
        ] {
            assert!(
                !clean.contains_key(key),
                "{key} crossed the transport boundary"
            );
        }
    }
}
