//! Linux GitHub-hosted Session parent -> credential-free child contract.
//! Synthetic Runner variables and local scripts only: no OIDC HTTP or Worker grant.
#[cfg(target_os = "linux")]
mod linux {
    use rca_native_agent::session_enrollment::new_session_identity;
    use rca_native_agent::session_registration::RegisteredSessionDevice;
    use rca_native_agent::session_runner::{
        checked_runner_context, spawn_credential_free_transport, validate_transport_grant,
    };
    use std::collections::BTreeMap;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    const UUID: &str = "123e4567-e89b-42d3-a456-426614174001";
    const NOW: u64 = 1_700_000_000_000;

    fn source(runner_temp: &str) -> BTreeMap<String, String> {
        [
            ("GITHUB_ACTIONS", "true"),
            ("RUNNER_ENVIRONMENT", "github-hosted"),
            ("GITHUB_WORKFLOW", "ubuntu"),
            ("GITHUB_RUN_ID", "44931213131"),
            ("GITHUB_RUN_ATTEMPT", "1"),
            ("ATTEMPT_ID", "123e4567-e89b-42d3-a456-426614174004"),
            ("GITHUB_REPOSITORY", "autoactions/github-actions"),
            ("RUNNER_TEMP", runner_temp),
            ("RUNNER_TRACKING_ID", "synthetic-job-ownership"),
            ("PATH", "/usr/bin:/bin"),
            ("HOME", "/home/runner"),
            ("ACTIONS_ID_TOKEN_REQUEST_URL", "https://oidc.example/token"),
            ("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "SENSITIVE_RUNNER_BEARER"),
            ("WORKFLOW_ACTION_OIDC_AUDIENCE", "SENSITIVE_AUDIENCE"),
            ("GH_TOKEN", "SENSITIVE_GH"),
            ("LD_PRELOAD", "SENSITIVE_PRELOAD"),
            ("NODE_OPTIONS", "--require=SENSITIVE_EXECUTOR"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
        .chain([("RUNNER_TEMP".to_owned(), runner_temp.to_owned())])
        .collect()
    }

    fn grant(expiry: u64) -> RegisteredSessionDevice {
        RegisteredSessionDevice {
            device_id: UUID.into(),
            expires_at: expiry,
        }
    }

    #[test]
    fn only_a_reviewed_physical_ubuntu_runner_can_launch() {
        let env = source("/tmp/test-runner");
        let (attempt, temp) = checked_runner_context(&env).unwrap();
        assert_eq!(attempt.attempt_id, "123e4567-e89b-42d3-a456-426614174004");
        assert_eq!(attempt.github_run_id, 44931213131);
        assert_eq!(temp.to_str().unwrap(), "/tmp/test-runner");
        for (name, value) in [
            ("GITHUB_ACTIONS", "false"),
            ("RUNNER_ENVIRONMENT", "self-hosted"),
            ("GITHUB_WORKFLOW", "windows"),
            ("GITHUB_RUN_ID", "0"),
            ("GITHUB_RUN_ATTEMPT", "oops"),
            ("ATTEMPT_ID", "invalid"),
            ("RUNNER_TEMP", "relative"),
            ("RUNNER_TRACKING_ID", ""),
        ] {
            let mut wrong = env.clone();
            wrong.insert(name.into(), value.into());
            assert!(checked_runner_context(&wrong).is_err(), "accepted {name}");
        }
    }

    #[test]
    fn invalid_expired_or_excessive_grants_never_launch() {
        assert!(validate_transport_grant(&grant(NOW + 300_000), NOW).is_ok());
        for wrong in [
            grant(NOW),
            grant(NOW - 1),
            grant(NOW + 300 * 60_000 + 1),
            RegisteredSessionDevice {
                device_id: "forged".into(),
                expires_at: NOW + 5_000,
            },
        ] {
            assert!(validate_transport_grant(&wrong, NOW).is_err());
        }
    }

    #[test]
    fn real_detached_child_inherits_only_reviewed_runner_variables() {
        let temp = tempfile::tempdir().unwrap();
        let executable = temp.path().join("child.sh");
        let log = temp.path().join("captured-env");
        let args = temp.path().join("captured-args");
        fs::write(&executable, "#!/bin/sh\nenv >\"$RUNNER_TEMP/captured-env\"\nprintf '%s\\n' \"$@\" >\"$RUNNER_TEMP/captured-args\"\nsleep 0.2\n").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let env = source(temp.path().to_str().unwrap());
        let attempt = checked_runner_context(&env).unwrap().0;
        let identity = new_session_identity(&attempt).unwrap();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        let mut child =
            spawn_credential_free_transport(&executable, &grant(now + 60_000), &identity, &env)
                .unwrap();
        assert_eq!(
            unsafe { libc::getsid(child.id() as i32) },
            child.id() as i32,
            "transport must start its own Unix session"
        );
        assert!(child.wait().unwrap().success());
        let data = fs::read_to_string(log).unwrap();
        assert!(data.contains("RUNNER_TRACKING_ID=synthetic-job-ownership"));
        assert!(data.contains("GITHUB_WORKFLOW=ubuntu"));
        for sensitive in [
            "SENSITIVE_",
            "ACTIONS_ID_TOKEN_REQUEST_URL=",
            "ACTIONS_ID_TOKEN_REQUEST_TOKEN=",
            "WORKFLOW_ACTION_OIDC_AUDIENCE=",
            "GH_TOKEN=",
            "LD_PRELOAD=",
            "NODE_OPTIONS=",
        ] {
            assert!(!data.contains(sensitive), "child inherited {sensitive}");
        }
        assert_eq!(
            fs::read_to_string(args).unwrap(),
            format!("--session-transport\n{UUID}\n{}\n", now + 60_000)
        );
    }

    #[test]
    fn mismatched_attempt_and_linked_executable_cannot_spawn() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let program = temp.path().join("child.sh");
        let marker = temp.path().join("executed");
        fs::write(
            &program,
            format!("#!/bin/sh\ntouch '{}'\n", marker.display()),
        )
        .unwrap();
        fs::set_permissions(&program, fs::Permissions::from_mode(0o700)).unwrap();
        let alias = temp.path().join("linked-child.sh");
        symlink(&program, &alias).unwrap();
        let env = source(temp.path().to_str().unwrap());
        let attempt = checked_runner_context(&env).unwrap().0;
        let identity = new_session_identity(&attempt).unwrap();
        let mut other_attempt = identity.clone();
        other_attempt.attempt.github_run_attempt += 1;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        let ticket = grant(now + 60_000);
        assert!(spawn_credential_free_transport(&program, &ticket, &other_attempt, &env).is_err());
        assert!(spawn_credential_free_transport(&alias, &ticket, &identity, &env).is_err());
        assert!(!marker.exists(), "unsafe child executable was launched");
    }
}
