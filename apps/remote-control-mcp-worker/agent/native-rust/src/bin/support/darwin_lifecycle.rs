//! Native LaunchAgent contract. The exact configuration and observed process
//! must identify the installed program, never merely the service label.
use rca_native_agent::identity::valid_device_id;
use std::path::Path;

pub(super) const LABEL: &str = "org.mcp-workers.remote-control-agent";

pub(super) fn parse_automatic_result(
    raw: &str,
    device_id: &str,
) -> Result<Option<serde_json::Value>, ()> {
    if raw.len() > 1024 || !valid_device_id(device_id) {
        return Err(());
    }
    let value: serde_json::Value = serde_json::from_str(raw).map_err(|_| ())?;
    let object = value.as_object().ok_or(())?;
    let fields = [
        "device_id",
        "operation_id",
        "installed_version",
        "target_version",
        "status",
        "updated_at_unix_ms",
    ];
    if object.len() != fields.len() || fields.iter().any(|field| !object.contains_key(*field)) {
        return Err(());
    }
    let recorded_id = value["device_id"].as_str().ok_or(())?;
    if !valid_device_id(recorded_id) {
        return Err(());
    }
    if recorded_id != device_id {
        return Ok(None);
    }
    let operation = value["operation_id"].as_str().ok_or(())?;
    let installed = value["installed_version"].as_str().ok_or(())?;
    let target = value["target_version"].as_str().ok_or(())?;
    let status = value["status"].as_str().ok_or(())?;
    if operation.len() != 32
        || !operation.bytes().all(|byte| byte.is_ascii_hexdigit())
        || super::agent_release::stable_version(installed).is_none()
        || super::agent_release::stable_version(target).is_none()
        || value["updated_at_unix_ms"].as_u64().is_none()
        || !matches!(status, "success" | "failed_recovered" | "waiting_idle")
        || (status == "success") != (installed == target)
    {
        return Err(());
    }
    Ok(Some(value))
}

pub(super) fn mac_upgrade_binding_digest(
    plist: Option<&str>,
    cli: Option<&str>,
    endpoint: Option<&str>,
    stop: Option<&str>,
    key: &[u8],
    id: &[u8],
) -> Result<String, ()> {
    // Match macBindingDigest(JSON.stringify(macUpgradeBinding(...))) exactly:
    // property order is part of the existing cross-runtime contract.
    use sha2::{Digest, Sha256};
    let key_hash = format!("{:x}", Sha256::digest(key));
    let id_hash = format!("{:x}", Sha256::digest(id));
    let raw = format!(
        "{{\"plist\":{},\"cli\":{},\"endpoint\":{},\"stop\":{},\"keyHash\":{},\"idHash\":{}}}",
        serde_json::to_string(&plist).map_err(|_| ())?,
        serde_json::to_string(&cli).map_err(|_| ())?,
        serde_json::to_string(&endpoint).map_err(|_| ())?,
        serde_json::to_string(&stop).map_err(|_| ())?,
        serde_json::to_string(&key_hash).map_err(|_| ())?,
        serde_json::to_string(&id_hash).map_err(|_| ())?,
    );
    Ok(format!("{:x}", Sha256::digest(raw.as_bytes())))
}

pub(super) fn automatic_result_admits(
    prior: Option<&serde_json::Value>,
    target: &str,
    action: &str,
) -> bool {
    !prior.is_some_and(|result| {
        result["status"] == "failed_recovered"
            && (action == "waiting_idle" || result["target_version"] == target)
    })
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum BusyResultDisposition {
    RecordWaitingIdle,
    PreservePriorFailure,
}

pub(super) fn busy_result_disposition(
    prior: Option<&serde_json::Value>,
    target: &str,
) -> BusyResultDisposition {
    if automatic_result_admits(prior, target, "waiting_idle") {
        BusyResultDisposition::RecordWaitingIdle
    } else {
        BusyResultDisposition::PreservePriorFailure
    }
}

fn known_update_event(event: &str) -> bool {
    matches!(
        event,
        "automatic_check_refused"
            | "automatic_check_unconfirmed"
            | "automatic_check_launch_failed"
            | "latest_unavailable"
            | "asset_download_or_verification_failed"
            | "update_staging_failed"
            | "update_cleanup_unconfirmed"
            | "upgrade_helper_start_failed"
            | "upgrade_helper_nonzero_exit"
            | "waiting_idle"
            | "failed_recovered"
            | "update_succeeded"
    )
}

fn normalized_log_timestamp(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    if bytes.len() < 19
        || !bytes[..19]
            .iter()
            .enumerate()
            .all(|(index, byte)| match index {
                4 | 7 => *byte == b'-',
                10 => *byte == b' ',
                13 | 16 => *byte == b':',
                _ => byte.is_ascii_digit(),
            })
    {
        return None;
    }
    let suffix = &value[19..];
    if suffix.len() > 16
        || !suffix
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'.' | b'+' | b'-'))
    {
        return None;
    }
    Some(value.to_owned())
}

pub(super) fn parse_update_events(raw: &str) -> serde_json::Value {
    let events: Vec<_> = raw
        .lines()
        .filter_map(|line| {
            let (prefix, message) = line.split_once("RCA_UPDATE:")?;
            let timestamp = prefix
                .split_whitespace()
                .take(2)
                .collect::<Vec<_>>()
                .join(" ");
            let event = message.trim();
            let at = normalized_log_timestamp(&timestamp)?;
            if !known_update_event(event) {
                return None;
            }
            Some(serde_json::json!({"at":at,"event":event}))
        })
        .rev()
        .take(80)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    serde_json::Value::Array(events)
}

#[cfg_attr(all(test, not(target_os = "macos")), allow(dead_code))]
pub(super) fn record_update_event(event: &str) {
    if known_update_event(event) {
        #[cfg(target_os = "macos")]
        if let Ok(message) = std::ffi::CString::new(format!("RCA_UPDATE:{event}")) {
            // Fixed format string; event names come only from the allowlist above.
            unsafe {
                libc::syslog(libc::LOG_NOTICE, b"%s\0".as_ptr().cast(), message.as_ptr());
            }
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Registration {
    Absent,
    Present(Option<u32>),
    Unknown,
}

pub(super) fn registration(
    code: Option<i32>,
    stdout: &str,
    stderr: &str,
    executable: &Path,
) -> Registration {
    if code == Some(113) && stderr.contains("Could not find service") {
        return Registration::Absent;
    }
    if code != Some(0) {
        return Registration::Unknown;
    }
    let Some(executable) = executable.to_str() else {
        return Registration::Unknown;
    };
    let mut programs = stdout
        .lines()
        .filter_map(|line| line.trim().strip_prefix("program = "));
    if programs.next() != Some(executable) || programs.next().is_some() {
        return Registration::Unknown;
    }
    let mut pids = stdout
        .lines()
        .filter_map(|line| line.trim().strip_prefix("pid = "));
    let pid = pids
        .next()
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|pid| *pid != 0);
    if pids.next().is_some() {
        return Registration::Unknown;
    }
    Registration::Present(pid)
}

fn xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

pub(super) fn native_plist(
    executable: &Path,
    endpoint: &str,
    generation: &str,
) -> Result<String, ()> {
    if !valid_device_id(generation) || !executable.is_absolute() {
        return Err(());
    }
    let origin = url::Url::parse(endpoint).map_err(|_| ())?;
    if origin.scheme() != "https"
        || origin.host_str().is_none()
        || !origin.username().is_empty()
        || origin.password().is_some()
        || origin.path() != "/"
        || origin.port().is_some()
        || origin.query().is_some()
        || origin.fragment().is_some()
        || origin.as_str() != endpoint
    {
        return Err(());
    }
    let arguments = [
        executable.to_str().ok_or(())?,
        "--service",
        "--endpoint",
        endpoint,
        "--generation",
        generation,
    ];
    let arguments: String = arguments
        .iter()
        .map(|arg| format!("<string>{}</string>", xml(arg)))
        .collect();
    Ok(format!(concat!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n",
        "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n",
        "<plist version=\"1.0\"><dict>\n",
        "<key>Label</key><string>{}</string>\n",
        "<key>ProgramArguments</key><array>{}</array>\n",
        "<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n</dict></plist>\n"
    ), LABEL, arguments))
}

pub(super) fn installed_generation(
    raw: &str,
    executable: &Path,
    endpoint: &str,
) -> Result<String, ()> {
    let (_, last) = raw.rsplit_once("<string>").ok_or(())?;
    let (generation, _) = last.split_once("</string>").ok_or(())?;
    if raw != native_plist(executable, endpoint, generation)? {
        return Err(());
    }
    Ok(generation.to_owned())
}

// A local OFF request is durable before contacting the cloud. A cloud
// failure must not prevent local STOP; an uncertain launchd state must
// never be converted into a successful shutdown.
pub(super) fn stop_owned(
    persist: impl FnOnce() -> Result<(), ()>,
    cloud_stop: impl FnOnce() -> bool,
    observe: impl FnMut() -> Registration,
    bootout: impl FnOnce() -> bool,
    pause: impl FnMut(),
) -> Result<bool, ()> {
    persist()?;
    let cloud_confirmed = cloud_stop();
    unregister_owned(observe, bootout, pause, false)?;
    Ok(cloud_confirmed)
}

// After a bootstrap attempt, even an absent first observation may precede
// asynchronous registration. Require stable absence before reporting recovery.
pub(super) fn unregister_owned(
    mut observe: impl FnMut() -> Registration,
    bootout: impl FnOnce() -> bool,
    mut pause: impl FnMut(),
    confirm_absence: bool,
) -> Result<(), ()> {
    match observe() {
        Registration::Unknown => return Err(()),
        Registration::Absent if !confirm_absence => return Ok(()),
        Registration::Absent => (),
        Registration::Present(_) if !bootout() => return Err(()),
        Registration::Present(_) => (),
    }
    let mut absent = 0;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    for attempt in 0..40 {
        if std::time::Instant::now() >= deadline {
            break;
        }
        match observe() {
            Registration::Unknown => return Err(()),
            Registration::Present(_) => absent = 0,
            Registration::Absent => {
                absent += 1;
                if absent == 2 {
                    return Ok(());
                }
            }
        }
        if attempt != 39 {
            pause();
        }
    }
    Err(())
}

// Resume is explicit, ordered, and never reported as online from bootstrap
// acknowledgement. Any failure after authorization preserves the OFF state.
pub(super) fn resume_owned(
    observe: impl FnOnce() -> Registration,
    authorize: impl FnOnce() -> Result<(), ()>,
    clear_off: impl FnOnce() -> Result<(), ()>,
    bootstrap: impl FnOnce() -> bool,
    online: impl FnOnce() -> bool,
    restore_off: impl FnOnce() -> Result<(), ()>,
) -> Result<(), ()> {
    if observe() != Registration::Absent {
        return Err(());
    }
    authorize()?;
    if clear_off().is_ok() && bootstrap() && online() {
        return Ok(());
    }
    restore_off()?;
    Err(())
}

pub(super) fn connection_time(
    raw: &str,
    generation: &str,
    version: &str,
    pid: u32,
    now: u64,
) -> Option<(bool, u64)> {
    let record: serde_json::Value = serde_json::from_str(raw).ok()?;
    if record["generation"] != generation
        || record["version"] != version
        || record["pid"].as_u64()? != u64::from(pid)
    {
        return None;
    }
    let connected = match record["state"].as_str()? {
        "connected" => true,
        "disconnected" | "rejected" => false,
        _ => return None,
    };
    let at = record["at"].as_u64()?;
    (at <= now.saturating_add(10_000)).then_some((connected, at))
}

pub(super) fn iso_time(ms: u64) -> Option<String> {
    let seconds = libc::time_t::try_from(ms / 1000).ok()?;
    let mut value = std::mem::MaybeUninit::<libc::tm>::uninit();
    if unsafe { libc::gmtime_r(&seconds, value.as_mut_ptr()) }.is_null() {
        return None;
    }
    let value = unsafe { value.assume_init() };
    let year = value.tm_year.checked_add(1900)?;
    if !(0..=9999).contains(&year) {
        return None;
    }
    Some(format!(
        "{year:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        value.tm_mon + 1,
        value.tm_mday,
        value.tm_hour,
        value.tm_min,
        value.tm_sec,
        ms % 1000
    ))
}

// A matching local process marker establishes local running evidence even
// when the separate signed WSS confirmation is unavailable or disconnected.
pub(super) fn apply_connection_observation(
    state: &mut serde_json::Value,
    stopped: bool,
    observed: Registration,
    evidence: Option<(bool, u64, bool)>,
) {
    let evidence = match (&observed, stopped) {
        (Registration::Present(Some(_)), false) => evidence,
        _ => None,
    };
    let local = match (stopped, observed) {
        (true, Registration::Absent) => "intentionally_stopped",
        (true, _) => "stopped_requested_unverified",
        (false, Registration::Present(_)) if evidence.is_some() => "running_observed",
        (false, Registration::Present(_)) => "present_unverified",
        (false, Registration::Absent) => "not_running",
        _ => "unconfirmed",
    };
    state["local_service"] = serde_json::json!(local);
    state["signed_wss"] = serde_json::json!(if evidence
        .is_some_and(|(connected, _, online)| connected && online)
    {
        "connected_observed"
    } else {
        "unconfirmed"
    });
    state["last_online"] = serde_json::json!(evidence
        .and_then(|(connected, at, _)| if connected { iso_time(at) } else { None })
        .unwrap_or_else(|| "unconfirmed".to_owned()));
}

pub(super) fn default_diagnostics(arch: &str) -> serde_json::Value {
    serde_json::json!({"installed":null,"version":null,"installed_version":null,
        "platform":"darwin","arch":arch,"device_id":null,"identity_present":null,
        "local_service":"unconfirmed","signed_wss":"unconfirmed","cloud_authorization":"unconfirmed",
        "cloud_approval":"unconfirmed","last_online":"unconfirmed","automatic_update":"unknown",
        "automatic_update_activity":"unknown","automatic_update_result":null,"receipts":"preserved_unverified"})
}

pub(super) fn apply_policy_observation(
    state: &mut serde_json::Value,
    policy: &str,
    unresolved: bool,
) {
    state["automatic_update"] = serde_json::json!(policy);
    state["automatic_update_activity"] = serde_json::json!(if unresolved {
        "needs_attention"
    } else if policy == "off" {
        "disabled"
    } else {
        "unknown"
    });
    if unresolved {
        state["update_transaction"] = serde_json::json!("pending_or_cleanup");
    }
}

// Diagnostics are projections of one local observation, not independent
// queries or repair operations. Never expose raw identity/receipt contents.
pub(super) fn diagnostic_response(action: &str, state: &serde_json::Value) -> serde_json::Value {
    match action {
        "logs" => serde_json::json!({
            "source":"retained_local_connection_update_evidence_and_macos_unified_log",
            "connection":state["signed_wss"],"last_online":state["last_online"],
            "update_activity":state["automatic_update_activity"],
            "update_result":state["automatic_update_result"],"transaction":state["update_transaction"],
            "update_events":state["update_events"]
        }),
        "doctor" => {
            let mut findings = Vec::new();
            if state["installed"] == false {
                findings.push("permanent_service_not_installed");
            } else if state["local_service"] != "running_observed" {
                findings.push("local_service_unconfirmed");
            }
            if state["cloud_authorization"] != "confirmed" {
                findings.push("cloud_authorization_unconfirmed");
            }
            if state["signed_wss"] != "connected_observed" {
                findings.push("signed_wss_unconfirmed");
            }
            if !state["update_transaction"].is_null()
                || matches!(
                    state["automatic_update_activity"].as_str(),
                    Some("unknown" | "needs_attention")
                )
            {
                findings.push("update_state_needs_review");
            }
            serde_json::json!({"status":state,"findings":findings})
        }
        _ => state.clone(),
    }
}

pub(super) fn native_cli(executable: &Path) -> Result<String, ()> {
    let path = executable.to_str().ok_or(())?;
    if !executable.is_absolute() || path.chars().any(|c| c.is_control()) {
        return Err(());
    }
    let quoted = format!("'{}'", path.replace('\'', "'\"'\"'"));
    Ok(format!("#!/bin/sh\nset -eu\ncase \"${{1:-}}\" in\nstatus|doctor) [ \"$#\" -eq 1 ] || {{ [ \"$#\" -eq 2 ] && [ \"$2\" = --json ]; }} || exit 2 ;;\n\"\") [ \"$#\" -eq 0 ] || exit 2 ;;\nlogs|stop|start|restart|pair|recover|uninstall|--help|--version|version) [ \"$#\" -eq 1 ] || exit 2 ;;\nupdate|upgrade) [ \"$#\" -eq 1 ] || {{ [ \"$#\" -eq 2 ] && {{ [ \"$2\" = --auto ] || [ \"$2\" = --check ]; }}; }} || {{ [ \"$#\" -eq 3 ] && [ \"$2\" = --auto ] && {{ [ \"$3\" = on ] || [ \"$3\" = off ]; }}; }} || exit 2 ;;\nsecure-input) [ \"$#\" -eq 2 ] || exit 2; case \"$2\" in ????????-????-????-????-????????????) ;; *) exit 2 ;; esac; case \"$2\" in *[!0-9a-f-]*) exit 2 ;; esac ;;\n*) echo 'Use the reviewed installer for installation or upgrade.' >&2; exit 2 ;;\nesac\nexec {quoted} \"$@\"\n"))
}

pub(super) fn new_generation() -> Result<String, ()> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| ())?;
    bytes[6] = (bytes[6] & 15) | 0x40;
    bytes[8] = (bytes[8] & 63) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    ))
}

// A switch can finish only at one of the two independently established
// configurations. Recovery never guesses which service is running.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum SwitchOutcome {
    Complete,
    Rollback,
    Unknown,
}

pub(super) fn switch_outcome(
    next_config: bool,
    previous_config: bool,
    stopped: bool,
    next_registration: &Registration,
    previous_registration: &Registration,
    next_online: bool,
    previous_online: bool,
) -> SwitchOutcome {
    if next_config
        && !previous_config
        && ((stopped && *next_registration == Registration::Absent)
            || (!stopped
                && matches!(next_registration, Registration::Present(Some(_)))
                && next_online))
    {
        SwitchOutcome::Complete
    } else if previous_config
        && !next_config
        && ((stopped && *previous_registration == Registration::Absent)
            || (!stopped
                && matches!(previous_registration, Registration::Present(Some(_)))
                && previous_online))
    {
        SwitchOutcome::Rollback
    } else {
        SwitchOutcome::Unknown
    }
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SwitchRecord {
    pub version: String,
    pub previous: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binding: Option<String>,
    pub generation: String,
    pub stopped: bool,
    pub phase: String,
}

impl SwitchRecord {
    // Restore only the journal-bound installation when no service is registered.
    pub fn can_restore_previous(
        &self,
        binding: &str,
        configuration: Option<&str>,
        next_configuration: &str,
        registration: &Registration,
    ) -> bool {
        !self.stopped
            && self.binding.as_deref() == Some(binding)
            && self.previous.as_deref().is_some_and(|previous| {
                previous != next_configuration
                    && (configuration == Some(previous)
                        || configuration == Some(next_configuration))
            })
            && *registration == Registration::Absent
    }

    pub fn can_abandon_initial(
        &self,
        configuration: Option<&str>,
        expected: Option<&str>,
        launcher: Option<&str>,
        registration: &Registration,
    ) -> bool {
        self.previous.is_none()
            && (configuration.is_none() || (!self.stopped && configuration == expected))
            && launcher.is_none()
            && *registration == Registration::Absent
    }

    pub fn parse(raw: &str, target: &str) -> Result<Self, ()> {
        let record: Self = serde_json::from_str(raw).map_err(|_| ())?;
        let version = record
            .version
            .strip_suffix(&format!("-{target}"))
            .ok_or(())?;
        if record.binding.as_ref().is_some_and(|digest| {
            digest.len() != 64
                || !digest
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        }) || record.phase != "switch_pending"
            || !valid_device_id(&record.generation)
            || !super::darwin_package::valid_version(version)
        {
            return Err(());
        }
        Ok(record)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum UninstallRecovery {
    RetainOnline,
    RetainStopped,
    Restore,
    Unknown,
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct UninstallRecord {
    pub phase: String,
    pub version: String,
    pub generation: String,
    pub stopped: bool,
    pub binding: String,
    pub inventory:
        Option<std::collections::BTreeMap<String, super::darwin_package::RemovalInventory>>,
}

impl UninstallRecord {
    pub fn parse(raw: &str, target: &str) -> Result<Self, ()> {
        let record: Self = serde_json::from_str(raw).map_err(|_| ())?;
        let version = record
            .version
            .strip_suffix(&format!("-{target}"))
            .ok_or(())?;
        let valid_digest = |s: &str| {
            s.len() == 64
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        };
        let valid_phase = match (&*record.phase, &record.inventory) {
            ("uninstall_pending", None) => true,
            ("uninstall_removing", Some(inventory)) => {
                inventory.contains_key(&record.version)
                    && inventory.iter().all(|(name, files)| {
                        name.strip_suffix(&format!("-{target}"))
                            .is_some_and(super::darwin_package::valid_version)
                            && (files.len() == 3 || files.len() == 4)
                            && files.iter().all(|digest| valid_digest(digest))
                    })
            }
            _ => false,
        };
        if !valid_phase
            || !valid_device_id(&record.generation)
            || !super::darwin_package::valid_version(version)
            || record.binding.len() != 64
            || !record
                .binding
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(());
        }
        Ok(record)
    }

    // Callers reject foreign configuration and unreviewed packages before
    // classifying their presence. Partial removal is not success.
    pub fn recovery(
        &self,
        configuration: bool,
        launcher: bool,
        empty: bool,
        registration: &Registration,
        signed: bool,
    ) -> UninstallRecovery {
        use UninstallRecovery::*;
        match (
            configuration,
            launcher,
            empty,
            self.stopped,
            registration,
            signed,
        ) {
            (true, true, false, true, Registration::Absent, _) => RetainStopped,
            (true, true, false, false, Registration::Absent, _) => Restore,
            (true, true, false, false, Registration::Present(Some(_)), true) => RetainOnline,
            _ => Unknown,
        }
    }
}

// Same-config restart reuses the switch journal; a changed PID alone is
// not evidence that the replacement has the same identity and signed WSS.
#[derive(serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RestartRecord {
    pub phase: String,
    pub version: String,
    pub generation: String,
    pub binding: String,
    pub pid: u32,
}

impl RestartRecord {
    pub fn parse(raw: &str, target: &str) -> Result<Self, ()> {
        let record: Self = serde_json::from_str(raw).map_err(|_| ())?;
        let version = record
            .version
            .strip_suffix(&format!("-{target}"))
            .ok_or(())?;
        if !matches!(
            record.phase.as_str(),
            "restart_preparing" | "restart_pending"
        ) || !valid_device_id(&record.generation)
            || !super::darwin_package::valid_version(version)
            || record.pid == 0
            || record.binding.len() != 64
            || !record
                .binding
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(());
        }
        Ok(record)
    }

    pub fn original_recoverable(
        &self,
        binding: &str,
        registration: &Registration,
        signed: bool,
    ) -> bool {
        self.phase == "restart_preparing"
            && self.binding == binding
            && signed
            && *registration == Registration::Present(Some(self.pid))
    }

    pub fn replacement_proven(
        &self,
        binding: &str,
        registration: &Registration,
        signed: bool,
    ) -> bool {
        self.binding == binding
            && signed
            && matches!(registration, Registration::Present(Some(pid)) if *pid != self.pid)
    }
}

pub(super) fn no_other_programs(raw: &str, programs: &Path, uid: u32, own_pid: u32) -> bool {
    let Some(root) = programs.to_str() else {
        return false;
    };
    let prefix = format!("{root}/");
    if raw.trim().is_empty() {
        return false;
    }
    for line in raw.lines() {
        let Some((pid, rest)) = line.trim_start().split_once(char::is_whitespace) else {
            return false;
        };
        let Some((owner, command)) = rest.trim_start().split_once(char::is_whitespace) else {
            return false;
        };
        let (Ok(pid), Ok(owner)) = (pid.parse::<u32>(), owner.parse::<u32>()) else {
            return false;
        };
        if command.trim().is_empty()
            || (pid != own_pid && owner == uid && command.contains(&prefix))
        {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    const ID: &str = "123e4567-e89b-42d3-a456-426614174001";
    const ENDPOINT: &str = "https://example.invalid/";

    #[test]
    fn uninstall_recovery_distinguishes_intact_completed_and_partial() {
        let mut record = UninstallRecord {
            phase: "uninstall_pending".into(),
            version: "v0.1.61-darwin-arm64".into(),
            generation: ID.into(),
            stopped: false,
            binding: "a".repeat(64),
            inventory: None,
        };
        let raw = serde_json::to_string(&record).unwrap();
        assert!(UninstallRecord::parse(&raw, "darwin-arm64").is_ok());
        assert!(UninstallRecord::parse(&raw, "darwin-x64").is_err());
        let active = Registration::Present(Some(42));
        let absent = Registration::Absent;
        let unknown = Registration::Unknown;
        assert_eq!(
            record.recovery(true, true, false, &active, true),
            UninstallRecovery::RetainOnline
        );
        assert_eq!(
            record.recovery(true, true, false, &active, false),
            UninstallRecovery::Unknown
        );
        assert_eq!(
            record.recovery(true, true, false, &absent, false),
            UninstallRecovery::Restore
        );
        assert_eq!(
            record.recovery(true, true, false, &unknown, false),
            UninstallRecovery::Unknown
        );
        assert_eq!(
            record.recovery(false, false, true, &absent, false),
            UninstallRecovery::Unknown
        );
        assert_eq!(
            record.recovery(false, false, true, &unknown, false),
            UninstallRecovery::Unknown
        );
        assert_eq!(
            record.recovery(false, true, false, &absent, false),
            UninstallRecovery::Unknown
        );
        assert_eq!(
            record.recovery(false, false, false, &absent, false),
            UninstallRecovery::Unknown
        );
        record.phase = "uninstall_removing".into();
        assert!(
            UninstallRecord::parse(&serde_json::to_string(&record).unwrap(), "darwin-arm64")
                .is_err()
        );
        record.inventory = Some(std::collections::BTreeMap::from([(
            record.version.clone(),
            vec![
                "a".repeat(64),
                "b".repeat(64),
                "c".repeat(64),
                "d".repeat(64),
            ],
        )]));
        assert!(
            UninstallRecord::parse(&serde_json::to_string(&record).unwrap(), "darwin-arm64")
                .is_ok()
        );
        record.inventory.as_mut().unwrap().insert(
            "v0.1.59-darwin-arm64".into(),
            vec!["e".repeat(64), "f".repeat(64), "0".repeat(64)],
        );
        assert!(
            UninstallRecord::parse(&serde_json::to_string(&record).unwrap(), "darwin-arm64")
                .is_ok()
        );
        record
            .inventory
            .as_mut()
            .unwrap()
            .remove("v0.1.59-darwin-arm64");
        record.inventory.as_mut().unwrap().insert(
            "../foreign-darwin-arm64".into(),
            vec![
                "a".repeat(64),
                "b".repeat(64),
                "c".repeat(64),
                "d".repeat(64),
            ],
        );
        assert!(
            UninstallRecord::parse(&serde_json::to_string(&record).unwrap(), "darwin-arm64")
                .is_err()
        );
        record.phase = "uninstall_pending".into();
        record.inventory = None;
        record.stopped = true;
        assert_eq!(
            record.recovery(true, true, false, &absent, false),
            UninstallRecovery::RetainStopped
        );
        assert_eq!(
            record.recovery(true, true, false, &active, true),
            UninstallRecovery::Unknown
        );
    }

    #[test]
    fn restart_requires_same_binding_and_distinct_signed_process() {
        let record = RestartRecord {
            phase: "restart_pending".into(),
            version: "v0.1.61-darwin-arm64".into(),
            generation: ID.into(),
            binding: "a".repeat(64),
            pid: 42,
        };
        let raw = serde_json::to_string(&record).unwrap();
        let record = RestartRecord::parse(&raw, "darwin-arm64").unwrap();
        assert!(RestartRecord::parse(&raw, "darwin-x64").is_err());
        assert!(RestartRecord::parse(&raw.replace("42}", "0}"), "darwin-arm64").is_err());
        assert!(record.replacement_proven(&"a".repeat(64), &Registration::Present(Some(43)), true));
        assert!(!record.replacement_proven(
            &"b".repeat(64),
            &Registration::Present(Some(43)),
            true
        ));
        assert!(!record.replacement_proven(
            &"a".repeat(64),
            &Registration::Present(Some(42)),
            true
        ));
        assert!(!record.replacement_proven(
            &"a".repeat(64),
            &Registration::Present(Some(43)),
            false
        ));
        assert!(!record.replacement_proven(&"a".repeat(64), &Registration::Absent, true));
        assert!(!record.replacement_proven(&"a".repeat(64), &Registration::Unknown, true));
        assert!(!record.original_recoverable(
            &"a".repeat(64),
            &Registration::Present(Some(42)),
            true
        ));
        let preparing = RestartRecord::parse(
            &raw.replace("restart_pending", "restart_preparing"),
            "darwin-arm64",
        )
        .unwrap();
        assert!(preparing.original_recoverable(
            &"a".repeat(64),
            &Registration::Present(Some(42)),
            true
        ));
        assert!(!preparing.original_recoverable(
            &"a".repeat(64),
            &Registration::Present(Some(43)),
            true
        ));
        assert!(!preparing.original_recoverable(
            &"a".repeat(64),
            &Registration::Present(Some(42)),
            false
        ));
        assert!(!preparing.original_recoverable(
            &"b".repeat(64),
            &Registration::Present(Some(42)),
            true
        ));
    }

    #[test]
    fn resume_requires_authority_and_fresh_online_or_restores_off() {
        use std::cell::RefCell;
        let events = RefCell::new(Vec::new());
        assert!(resume_owned(
            || Registration::Absent,
            || {
                events.borrow_mut().push("authorize");
                Ok(())
            },
            || {
                events.borrow_mut().push("clear");
                Ok(())
            },
            || {
                events.borrow_mut().push("bootstrap");
                true
            },
            || {
                events.borrow_mut().push("online");
                false
            },
            || {
                events.borrow_mut().push("restore");
                Ok(())
            },
        )
        .is_err());
        assert_eq!(
            *events.borrow(),
            ["authorize", "clear", "bootstrap", "online", "restore"]
        );
        assert!(resume_owned(
            || Registration::Absent,
            || Err(()),
            || panic!("no authorization"),
            || panic!("no authorization"),
            || panic!("no authorization"),
            || panic!("OFF unchanged"),
        )
        .is_err());
        assert!(resume_owned(
            || Registration::Unknown,
            || panic!("uncertain registration"),
            || panic!("uncertain registration"),
            || panic!("uncertain registration"),
            || panic!("uncertain registration"),
            || panic!("OFF unchanged"),
        )
        .is_err());
        assert!(resume_owned(
            || Registration::Absent,
            || Ok(()),
            || Ok(()),
            || true,
            || true,
            || panic!("healthy replacement"),
        )
        .is_ok());
        assert!(resume_owned(
            || Registration::Absent,
            || Ok(()),
            || Err(()),
            || panic!("OFF removal failed"),
            || panic!("OFF removal failed"),
            || Ok(()),
        )
        .is_err());
    }

    #[test]
    fn connection_marker_must_match_generation_version_pid_and_clock() {
        assert_eq!(iso_time(1001).as_deref(), Some("1970-01-01T00:00:01.001Z"));
        assert!(iso_time(u64::MAX).is_none());
        let raw = serde_json::json!({"generation":ID,"version":"v0.1.60","pid":123,
            "state":"connected","at":1000})
        .to_string();
        assert_eq!(
            connection_time(&raw, ID, "v0.1.60", 123, 2000),
            Some((true, 1000))
        );
        assert!(connection_time(&raw, "old", "v0.1.60", 123, 2000).is_none());
        assert!(connection_time(&raw, ID, "v0.1.59", 123, 2000).is_none());
        assert!(connection_time(&raw, ID, "v0.1.60", 124, 2000).is_none());
        assert!(
            connection_time(&raw.replace("1000", "999999"), ID, "v0.1.60", 123, 2000).is_none()
        );
        assert_eq!(
            connection_time(
                &raw.replace("connected", "disconnected"),
                ID,
                "v0.1.60",
                123,
                2000
            ),
            Some((false, 1000))
        );
    }

    #[test]
    fn removal_requires_readable_process_inventory_and_no_other_owner_program() {
        let root = Path::new("/Users/owner name/programs");
        assert!(no_other_programs(
            "  2   0 /sbin/launchd\n  42  501 /Users/owner name/programs/rca\n",
            root,
            501,
            42
        ));
        assert!(!no_other_programs(
            "  2   0 /sbin/launchd\n  43  501 /Users/owner name/programs/rca\n",
            root,
            501,
            42
        ));
        assert!(!no_other_programs("  invalid  501 /bin/sh", root, 501, 42));
        assert!(!no_other_programs("", root, 501, 42));
        assert!(no_other_programs(
            "  43  502 /Users/owner name/programs/rca\n",
            root,
            501,
            42
        ));
    }

    #[test]
    fn interrupted_online_switch_can_restore_only_bound_absent_service() {
        let mut record = SwitchRecord {
            version: "v0.1.61-darwin-arm64".into(),
            previous: Some("old".into()),
            binding: Some("a".repeat(64)),
            generation: ID.into(),
            stopped: false,
            phase: "switch_pending".into(),
        };
        let binding = "a".repeat(64);
        assert!(record.can_restore_previous(&binding, Some("old"), "next", &Registration::Absent));
        assert!(record.can_restore_previous(&binding, Some("next"), "next", &Registration::Absent));
        assert!(!record.can_restore_previous(
            "changed",
            Some("old"),
            "next",
            &Registration::Absent
        ));
        assert!(!record.can_restore_previous(
            &binding,
            Some("foreign"),
            "next",
            &Registration::Absent
        ));
        assert!(!record.can_restore_previous(&binding, None, "next", &Registration::Absent));
        assert!(!record.can_restore_previous(
            &binding,
            Some("old"),
            "next",
            &Registration::Unknown
        ));
        assert!(!record.can_restore_previous(
            &binding,
            Some("old"),
            "next",
            &Registration::Present(None)
        ));
        record.stopped = true;
        assert!(!record.can_restore_previous(&binding, Some("old"), "next", &Registration::Absent));
        record.stopped = false;
        record.binding = None;
        assert!(!record.can_restore_previous(&binding, Some("old"), "next", &Registration::Absent));
    }

    #[test]
    fn initial_configured_but_unregistered_can_be_abandoned_only_with_exact_evidence() {
        let mut record = SwitchRecord {
            version: "v0.1.61-darwin-arm64".into(),
            previous: None,
            binding: None,
            generation: ID.into(),
            stopped: false,
            phase: "switch_pending".into(),
        };
        let config = "verified native plist";
        assert!(record.can_abandon_initial(
            Some(config),
            Some(config),
            None,
            &Registration::Absent
        ));
        assert!(!record.can_abandon_initial(Some(config), None, None, &Registration::Absent));
        assert!(!record.can_abandon_initial(
            Some("foreign"),
            Some(config),
            None,
            &Registration::Absent
        ));
        assert!(!record.can_abandon_initial(
            Some(config),
            Some(config),
            Some("launcher"),
            &Registration::Absent
        ));
        assert!(!record.can_abandon_initial(
            Some(config),
            Some(config),
            None,
            &Registration::Unknown
        ));
        assert!(!record.can_abandon_initial(
            Some(config),
            Some(config),
            None,
            &Registration::Present(None)
        ));
        record.stopped = true;
        assert!(!record.can_abandon_initial(
            Some(config),
            Some(config),
            None,
            &Registration::Absent
        ));
        record.stopped = false;
        record.previous = Some("old config".into());
        assert!(!record.can_abandon_initial(
            Some(config),
            Some(config),
            None,
            &Registration::Absent
        ));
    }

    #[test]
    fn interrupted_initial_install_can_be_abandoned_only_before_configuration() {
        let raw = serde_json::json!({"phase":"switch_pending","version":"v0.1.61-darwin-arm64",
            "previous":null,"generation":ID,"stopped":false})
        .to_string();
        let mut record = SwitchRecord::parse(&raw, "darwin-arm64").unwrap();
        assert!(record.can_abandon_initial(None, None, None, &Registration::Absent));
        assert!(!record.can_abandon_initial(
            Some("foreign configuration"),
            None,
            None,
            &Registration::Absent
        ));
        assert!(!record.can_abandon_initial(
            None,
            None,
            Some("existing launcher"),
            &Registration::Absent
        ));
        assert!(!record.can_abandon_initial(None, None, None, &Registration::Unknown));
        assert!(!record.can_abandon_initial(None, None, None, &Registration::Present(Some(42))));
        record.previous = Some("old configuration".to_owned());
        assert!(!record.can_abandon_initial(None, None, None, &Registration::Absent));
    }

    #[test]
    fn switch_evidence_distinguishes_complete_rollback_and_unknown() {
        let absent = Registration::Absent;
        let active = Registration::Present(Some(42));
        let unknown = Registration::Unknown;
        assert_eq!(
            switch_outcome(true, false, false, &active, &unknown, true, false),
            SwitchOutcome::Complete
        );
        assert_eq!(
            switch_outcome(true, false, false, &active, &unknown, false, false),
            SwitchOutcome::Unknown
        );
        assert_eq!(
            switch_outcome(false, true, false, &unknown, &active, false, true),
            SwitchOutcome::Rollback
        );
        assert_eq!(
            switch_outcome(true, false, true, &absent, &absent, false, false),
            SwitchOutcome::Complete
        );
        assert_eq!(
            switch_outcome(false, true, true, &absent, &absent, false, false),
            SwitchOutcome::Rollback
        );
        assert_eq!(
            switch_outcome(true, false, true, &unknown, &absent, false, false),
            SwitchOutcome::Unknown
        );
        assert_eq!(
            switch_outcome(true, true, false, &active, &active, true, true),
            SwitchOutcome::Unknown
        );
        let raw = serde_json::json!({"phase":"switch_pending","version":"v0.1.61-darwin-arm64",
            "previous":null,"generation":ID,"stopped":false})
        .to_string();
        assert!(SwitchRecord::parse(&raw, "darwin-arm64").is_ok());
        assert!(SwitchRecord::parse(&raw, "darwin-x64").is_err());
        assert!(
            SwitchRecord::parse(&raw.replace("v0.1.61", "../../foreign"), "darwin-arm64").is_err()
        );
        assert!(SwitchRecord::parse(&raw.replace("false", "true"), "darwin-arm64").is_ok());
        assert!(SwitchRecord::parse(
            &raw.replace("switch_pending", "uninstall_pending"),
            "darwin-arm64"
        )
        .is_err());
    }

    #[test]
    fn local_policy_evidence_does_not_claim_automatic_work() {
        let off = default_diagnostics("arm64");
        assert_eq!(off["installed"], serde_json::Value::Null);
        assert_eq!(off["identity_present"], serde_json::Value::Null);
        assert_eq!(off["automatic_update"], "unknown");
        let mut state = off.clone();
        apply_policy_observation(&mut state, "off", false);
        assert_eq!(state["automatic_update"], "off");
        assert_eq!(state["automatic_update_activity"], "disabled");
        apply_policy_observation(&mut state, "on", false);
        assert_eq!(state["automatic_update"], "on");
        assert_eq!(state["automatic_update_activity"], "unknown");
        apply_policy_observation(&mut state, "off", true);
        assert_eq!(state["automatic_update_activity"], "needs_attention");
        assert_eq!(state["update_transaction"], "pending_or_cleanup");
        assert_eq!(state["signed_wss"], "unconfirmed");
    }

    #[test]
    fn local_running_and_signed_connection_are_independent_observations() {
        let mut state = default_diagnostics("arm64");
        let at = 1_700_000_000_000;
        for (evidence, connection, last_online) in [
            (
                Some((true, at, true)),
                "connected_observed",
                "2023-11-14T22:13:20.000Z",
            ),
            (
                Some((true, at, false)),
                "unconfirmed",
                "2023-11-14T22:13:20.000Z",
            ),
            (Some((false, at, false)), "unconfirmed", "unconfirmed"),
        ] {
            apply_connection_observation(
                &mut state,
                false,
                Registration::Present(Some(123)),
                evidence,
            );
            assert_eq!(state["local_service"], "running_observed");
            assert_eq!(state["signed_wss"], connection);
            assert_eq!(state["last_online"], last_online);
            assert!(!diagnostic_response("doctor", &state)["findings"]
                .as_array()
                .unwrap()
                .iter()
                .any(|v| v == "local_service_unconfirmed"));
        }
        for (stopped, registration, evidence, local) in [
            (
                false,
                Registration::Present(Some(123)),
                None,
                "present_unverified",
            ),
            (
                false,
                Registration::Present(None),
                Some((true, at, true)),
                "present_unverified",
            ),
            (
                false,
                Registration::Absent,
                Some((true, at, true)),
                "not_running",
            ),
            (false, Registration::Unknown, None, "unconfirmed"),
            (
                true,
                Registration::Absent,
                Some((true, at, true)),
                "intentionally_stopped",
            ),
            (
                true,
                Registration::Present(Some(123)),
                Some((true, at, true)),
                "stopped_requested_unverified",
            ),
        ] {
            apply_connection_observation(&mut state, stopped, registration, evidence);
            assert_eq!(state["local_service"], local);
            assert_eq!(state["signed_wss"], "unconfirmed");
            assert_eq!(state["last_online"], "unconfirmed");
        }
    }

    #[test]
    fn update_events_only_expose_allowlisted_system_log_messages() {
        let raw = concat!(
            "2026-11-27 09:00:00.000000-0800 Df rca-standard-darwin-candidate[123]: RCA_UPDATE:latest_unavailable\n",
            "2026-11-27 09:01:00.000000-0800 Df rca-standard-darwin-candidate[123]: RCA_UPDATE:asset_download_or_verification_failed\n",
            "2026-11-27 09:02:00.000000-0800 Df rca-standard-darwin-candidate[123]: RCA_UPDATE:update_succeeded\n",
            "2026-11-27 09:03:00.000 Df rca-standard-darwin-candidate[123]: RCA_UPDATE:token=secret\n",
            "unrelated process event\n"
        );
        assert_eq!(
            super::parse_update_events(raw),
            serde_json::json!([
                {"at":"2026-11-27 09:00:00.000000-0800","event":"latest_unavailable"},
                {"at":"2026-11-27 09:01:00.000000-0800","event":"asset_download_or_verification_failed"},
                {"at":"2026-11-27 09:02:00.000000-0800","event":"update_succeeded"}
            ])
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn update_events_are_visible_in_macos_unified_log() {
        let pid = std::process::id();
        record_update_event("latest_unavailable");
        let predicate =
            format!("processIdentifier == {pid} AND eventMessage BEGINSWITH \"RCA_UPDATE:\"");
        let mut found = false;
        for _ in 0..10 {
            let output = std::process::Command::new("/usr/bin/log")
                .args([
                    "show",
                    "--last",
                    "1m",
                    "--style",
                    "compact",
                    "--predicate",
                    &predicate,
                ])
                .output()
                .expect("macOS unified log command must be available");
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let events = super::parse_update_events(&String::from_utf8_lossy(&output.stdout));
            if events.as_array().is_some_and(|events| {
                events
                    .iter()
                    .any(|event| event["event"] == "latest_unavailable")
            }) {
                found = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        assert!(
            found,
            "allowlisted update event was not visible in unified log"
        );
    }

    #[test]
    fn diagnostics_share_status_without_claiming_unobserved_connection() {
        let state = serde_json::json!({"installed":true,"local_service":"not_running",
            "signed_wss":"unconfirmed","last_online":"unconfirmed","cloud_authorization":"unconfirmed",
            "automatic_update":"off","automatic_update_activity":"disabled"});
        assert_eq!(diagnostic_response("status", &state), state);
        let doctor = diagnostic_response("doctor", &state);
        assert_eq!(doctor["status"], state);
        assert_eq!(
            doctor["findings"],
            serde_json::json!([
                "local_service_unconfirmed",
                "cloud_authorization_unconfirmed",
                "signed_wss_unconfirmed"
            ])
        );
        let mut log_state = state.clone();
        log_state["update_events"] = serde_json::json!({"status":"available","events":[
            {"at":"2026-11-27 09:00:00.000000-0800","event":"latest_unavailable"}
        ]});
        let logs = diagnostic_response("logs", &log_state);
        assert_eq!(logs["connection"], "unconfirmed");
        assert_eq!(logs["update_activity"], "disabled");
        assert_eq!(
            logs["update_events"]["events"][0]["event"],
            "latest_unavailable"
        );
        let absent = serde_json::json!({"installed":false,"local_service":"not_installed","signed_wss":"unconfirmed","cloud_authorization":"unconfirmed"});
        assert_eq!(
            diagnostic_response("doctor", &absent)["findings"][0],
            "permanent_service_not_installed"
        );
        let unknown = serde_json::json!({"installed":null,"local_service":"unconfirmed","signed_wss":"unconfirmed","cloud_authorization":"unconfirmed","update_transaction":"pending_or_cleanup"});
        let findings = diagnostic_response("doctor", &unknown)["findings"].clone();
        assert_eq!(findings[0], "local_service_unconfirmed");
        assert_eq!(findings[3], "update_state_needs_review");
    }

    #[test]
    fn native_cli_forwards_supported_commands_and_rejects_invalid_arguments() {
        let _fixture = crate::LOCK_HANDOFF_TEST.lock().unwrap();
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let executable = temp.path().join("owner's agent");
        std::fs::write(&executable, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n").unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let launcher = temp.path().join("rca");
        std::fs::write(&launcher, native_cli(&executable).unwrap()).unwrap();
        let invoke = |args: &[&str]| {
            std::process::Command::new("/bin/sh")
                .arg(&launcher)
                .args(args)
                .output()
                .unwrap()
        };
        let output = invoke(&["secure-input", ID]);
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            format!("secure-input\n{ID}\n")
        );
        for args in [
            &["status"][..],
            &["status", "--json"],
            &["doctor"],
            &["doctor", "--json"],
            &["logs"],
            &["update"],
            &["upgrade"],
            &["update", "--check"],
            &["upgrade", "--check"],
            &["update", "--auto"],
            &["update", "--auto", "on"],
            &["update", "--auto", "off"],
            &["upgrade", "--auto"],
            &["upgrade", "--auto", "on"],
            &["upgrade", "--auto", "off"],
            &["stop"],
            &["start"],
            &["restart"],
            &["pair"],
            &["--help"],
            &["--version"],
            &["version"],
            &["recover"],
            &["uninstall"],
            &[],
        ] {
            let output = invoke(args);
            assert!(output.status.success(), "{args:?}");
            assert_eq!(
                String::from_utf8(output.stdout).unwrap(),
                format!("{}\n", args.join("\n"))
            );
        }
        for args in [
            &["status", "--repair"][..],
            &["doctor", "--repair"],
            &["logs", "--repair"],
            &["update", "--auto", "yes"],
            &["update", "--auto", "on", "extra"],
            &["update", "--automatic"],
            &["update", "--check", "extra"],
            &["upgrade", "--auto", "ON"],
            &["secure-input"],
            &["secure-input", "bad"],
            &["secure-input", ID, "extra"],
            &["stop", "extra"],
            &["pair", "extra"],
            &["--service", ID],
            &["--help", "extra"],
            &["--version", "extra"],
            &["", "restart"],
        ] {
            assert_eq!(invoke(args).status.code(), Some(2));
        }
    }

    #[test]
    fn native_cli_quotes_owner_path_and_generation_is_unique() {
        let command = native_cli(Path::new("/Users/o'wner/rca")).unwrap();
        assert!(command.ends_with("exec '/Users/o'\"'\"'wner/rca' \"$@\"\n"));
        assert!(native_cli(Path::new("/tmp/bad\npath")).is_err());
        let generation = new_generation().unwrap();
        assert!(valid_device_id(&generation));
        assert_ne!(generation, new_generation().unwrap());
    }

    #[test]
    fn exact_native_plist_rejects_extra_arguments_and_foreign_program() {
        let exe = Path::new("/Users/test & owner/rca");
        let value = native_plist(exe, ENDPOINT, ID).unwrap();
        assert_eq!(
            installed_generation(&value, exe, ENDPOINT),
            Ok(ID.to_owned())
        );
        assert!(value.contains("test &amp; owner"));
        assert!(installed_generation(&value, Path::new("/tmp/foreign"), ENDPOINT).is_err());
        assert!(installed_generation(
            &value.replace("</array>", "<string>extra</string></array>"),
            exe,
            ENDPOINT
        )
        .is_err());
        assert!(
            installed_generation(&value.replace("<true/>", "<false/>"), exe, ENDPOINT).is_err()
        );
        assert!(native_plist(exe, "https://example.invalid:8443/", ID).is_err());
    }

    #[test]
    fn stop_preserves_off_intent_even_when_cloud_or_launchd_is_unconfirmed() {
        use std::cell::{Cell, RefCell};
        let events = RefCell::new(Vec::new());
        let observations = RefCell::new(
            vec![
                Registration::Present(Some(1)),
                Registration::Absent,
                Registration::Present(Some(1)),
                Registration::Absent,
                Registration::Absent,
            ]
            .into_iter(),
        );
        assert_eq!(
            stop_owned(
                || {
                    events.borrow_mut().push("persist");
                    Ok(())
                },
                || {
                    events.borrow_mut().push("cloud");
                    false
                },
                || {
                    events.borrow_mut().push("observe");
                    observations.borrow_mut().next().unwrap()
                },
                || {
                    events.borrow_mut().push("bootout");
                    true
                },
                || {},
            ),
            Ok(false)
        );
        assert_eq!(
            *events.borrow(),
            vec![
                "persist", "cloud", "observe", "bootout", "observe", "observe", "observe",
                "observe"
            ]
        );
        let persisted = Cell::new(false);
        assert!(stop_owned(
            || {
                persisted.set(true);
                Ok(())
            },
            || false,
            || Registration::Unknown,
            || panic!("unknown registration must not be stopped"),
            || {}
        )
        .is_err());
        assert!(persisted.get());
        assert!(stop_owned(
            || Err(()),
            || panic!("no durable OFF"),
            || panic!("no durable OFF"),
            || panic!("no durable OFF"),
            || {}
        )
        .is_err());
        assert!(stop_owned(
            || Ok(()),
            || true,
            || Registration::Present(Some(1)),
            || true,
            || {}
        )
        .is_err());
    }

    #[test]
    fn launchd_absence_and_exact_owned_registration_are_distinct() {
        let exe = Path::new("/Users/owner/rca");
        assert_eq!(
            registration(Some(113), "", "Could not find service", exe),
            Registration::Absent
        );
        assert_eq!(
            registration(Some(113), "", "Permission denied", exe),
            Registration::Unknown
        );
        assert_eq!(registration(None, "", "", exe), Registration::Unknown);
        assert_eq!(
            registration(Some(0), "program = /tmp/foreign\npid = 123\n", "", exe),
            Registration::Unknown
        );
        assert_eq!(
            registration(Some(0), "program = /Users/owner/rca\npid = 123\n", "", exe),
            Registration::Present(Some(123))
        );
        assert_eq!(
            registration(Some(0), "program = /Users/owner/rca\n", "", exe),
            Registration::Present(None)
        );
        assert_eq!(
            registration(
                Some(0),
                "program = /Users/owner/rca\npid = 123\npid = 456\n",
                "",
                exe
            ),
            Registration::Unknown
        );
    }
}

#[cfg(test)]
mod automatic_result_tests {
    use super::{
        automatic_result_admits, busy_result_disposition, parse_automatic_result,
        BusyResultDisposition,
    };
    use serde_json::json;

    const ID: &str = "123e4567-e89b-42d3-a456-426614174001";

    fn result(status: &str, installed: &str, target: &str) -> String {
        json!({
            "device_id": ID,
            "operation_id": "0123456789abcdef0123456789abcdef",
            "installed_version": installed,
            "target_version": target,
            "status": status,
            "updated_at_unix_ms": 1_795_700_000_000u64,
        })
        .to_string()
    }

    #[test]
    fn automatic_result_is_exact_identity_bound_and_semantically_consistent() {
        let valid = result("success", "v0.1.61", "v0.1.61");
        assert!(parse_automatic_result(&valid, ID).unwrap().is_some());
        assert_eq!(
            parse_automatic_result(&valid, "123e4567-e89b-42d3-a456-426614174002"),
            Ok(None)
        );
        assert!(parse_automatic_result(&result("success", "v0.1.60", "v0.1.61"), ID).is_err());
        assert!(
            parse_automatic_result(&result("failed_recovered", "v0.1.61", "v0.1.61"), ID).is_err()
        );
        let mut extra: serde_json::Value = serde_json::from_str(&valid).unwrap();
        extra["extra"] = json!(true);
        assert!(parse_automatic_result(&extra.to_string(), ID).is_err());
    }

    #[test]
    fn mac_upgrade_binding_digest_matches_the_existing_node_json_contract() {
        assert_eq!(
            super::mac_upgrade_binding_digest(
                Some("plist-content\n"),
                Some("#!/bin/sh\nexec \"/path/rca\" \"$@\"\n"),
                Some("https://example.test/"),
                None,
                b"key bytes\n",
                b"id bytes\n",
            )
            .unwrap(),
            "3dbf8ffad5e20a7f1ddcc66bdc7575a6982d55ead3c7753e4a20af19fc495e5c"
        );
    }

    #[test]
    fn verified_rollback_suppresses_only_the_same_target_and_no_idle_retry() {
        let failed: serde_json::Value =
            serde_json::from_str(&result("failed_recovered", "v0.1.60", "v0.1.61")).unwrap();
        assert!(!automatic_result_admits(Some(&failed), "v0.1.61", "admit"));
        assert!(!automatic_result_admits(
            Some(&failed),
            "v0.1.62",
            "waiting_idle"
        ));
        assert!(automatic_result_admits(Some(&failed), "v0.1.62", "admit"));
        let waiting: serde_json::Value =
            serde_json::from_str(&result("waiting_idle", "v0.1.60", "v0.1.61")).unwrap();
        assert!(automatic_result_admits(Some(&waiting), "v0.1.61", "admit"));
    }

    #[test]
    fn busy_newer_target_preserves_prior_failure_without_refusing_busy_cleanup() {
        let failed: serde_json::Value =
            serde_json::from_str(&result("failed_recovered", "v0.1.60", "v0.1.61")).unwrap();
        assert!(automatic_result_admits(Some(&failed), "v0.1.62", "admit"));
        assert_eq!(
            busy_result_disposition(Some(&failed), "v0.1.62"),
            BusyResultDisposition::PreservePriorFailure
        );
        assert_eq!(
            busy_result_disposition(None, "v0.1.62"),
            BusyResultDisposition::RecordWaitingIdle
        );
        let waiting: serde_json::Value =
            serde_json::from_str(&result("waiting_idle", "v0.1.60", "v0.1.61")).unwrap();
        assert_eq!(
            busy_result_disposition(Some(&waiting), "v0.1.62"),
            BusyResultDisposition::RecordWaitingIdle
        );
    }
}
