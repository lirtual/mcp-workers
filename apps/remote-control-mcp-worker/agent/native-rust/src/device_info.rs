//! Existing Worker device_info wire contract. Metadata is advisory; it
//! neither grants operations nor advertises the Node-only remote updater.
use serde_json::{json, Value};
use std::fs::File;
use std::io::Read;
use std::path::Path;

fn bounded_text(path: &Path, limit: u64) -> Option<String> {
    let mut text = String::new();
    File::open(path)
        .ok()?
        .take(limit + 1)
        .read_to_string(&mut text)
        .ok()?;
    (text.len() as u64 <= limit).then_some(text)
}

fn clean(value: &str, max: usize) -> String {
    let filtered: String = value
        .chars()
        .filter(|c| !matches!(*c, '\u{0}'..='\u{1f}' | '\u{7f}'))
        .collect();
    let mut result = String::new();
    let mut units = 0;
    for c in filtered.trim().chars() {
        units += c.len_utf16();
        if units > max {
            break;
        }
        result.push(c);
    }
    if result.is_empty() {
        "unknown".to_owned()
    } else {
        result
    }
}

fn valid_version(value: &str) -> bool {
    if value.len() > 48 {
        return false;
    }
    let Some(value) = value.strip_prefix('v') else {
        return false;
    };
    let (number, suffix) = value
        .split_once('-')
        .map_or((value, None), |(a, b)| (a, Some(b)));
    let parts: Vec<_> = number.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
        && suffix.is_none_or(|s| {
            !s.is_empty()
                && s.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
        })
}

pub fn installed_version(exe: &Path) -> Option<String> {
    // Standard packages put the executable in apps/remote-control-agent/.build.
    // Do not use an unrelated ancestor, CWD, or Cargo's internal version.
    let build = exe.parent()?;
    let app = build.parent()?;
    let apps = app.parent()?;
    if build.file_name()? != ".build"
        || app.file_name()? != "remote-control-agent"
        || apps.file_name()? != "apps"
    {
        return None;
    }
    let value: Value =
        serde_json::from_str(&bounded_text(&apps.parent()?.join("bundle.json"), 65536)?).ok()?;
    let version = value["version"].as_str()?;
    (value["name"] == "remote-control-agent" && valid_version(version)).then(|| version.to_owned())
}

#[cfg(unix)]
fn platform() -> (String, String) {
    // SAFETY: successful uname initializes NUL-terminated utsname fields.
    let mut info: libc::utsname = unsafe { std::mem::zeroed() };
    if unsafe { libc::uname(&mut info) } != 0 {
        return ("unknown".into(), "unknown".into());
    }
    unsafe {
        (
            std::ffi::CStr::from_ptr(info.nodename.as_ptr())
                .to_string_lossy()
                .into_owned(),
            std::ffi::CStr::from_ptr(info.release.as_ptr())
                .to_string_lossy()
                .into_owned(),
        )
    }
}

#[cfg(windows)]
fn platform() -> (String, String) {
    use windows_sys::Win32::System::SystemInformation::{
        ComputerNamePhysicalDnsHostname, GetComputerNameExW, OSVERSIONINFOW,
    };
    // GetVersionExW can report a compatibility version without an application
    // manifest. RtlGetVersion reports the actual OS build.
    #[link(name = "ntdll")]
    extern "system" {
        fn RtlGetVersion(info: *mut OSVERSIONINFOW) -> i32;
    }
    let mut name = [0u16; 256];
    let mut size = name.len() as u32;
    let hostname = if unsafe {
        GetComputerNameExW(
            ComputerNamePhysicalDnsHostname,
            name.as_mut_ptr(),
            &mut size,
        )
    } != 0
    {
        String::from_utf16_lossy(&name[..(size as usize).min(name.len())])
    } else {
        "unknown".into()
    };
    let mut info = OSVERSIONINFOW {
        dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32,
        ..Default::default()
    };
    let version = if unsafe { RtlGetVersion(&mut info) } == 0 {
        format!(
            "{}.{}.{}",
            info.dwMajorVersion, info.dwMinorVersion, info.dwBuildNumber
        )
    } else {
        "unknown".into()
    };
    (hostname, version)
}

#[cfg(target_os = "linux")]
fn linux_environment(kernel: &str, container: bool, wsl_env: bool) -> &'static str {
    let kernel = kernel.to_ascii_lowercase();
    if container {
        "container"
    } else if kernel.contains("microsoft") && (kernel.contains("wsl") || wsl_env) {
        "wsl2"
    } else {
        "native"
    }
}

#[cfg(target_os = "linux")]
fn linux_version(kernel: &str, release: Option<&str>) -> String {
    release
        .and_then(|s| s.lines().find_map(|line| line.strip_prefix("PRETTY_NAME=")))
        .map(|s| {
            s.strip_prefix('"')
                .and_then(|s| s.strip_suffix('"'))
                .unwrap_or(s)
        })
        .filter(|s| !s.is_empty())
        .unwrap_or(kernel)
        .to_owned()
}

pub(crate) struct DeviceInfo {
    hostname: String,
    os_version: String,
    environment: &'static str,
    version: Option<String>,
}

impl DeviceInfo {
    pub(crate) fn collect() -> Self {
        let (hostname, kernel) = platform();
        #[cfg(target_os = "linux")]
        let (os_version, environment) = (
            linux_version(
                &kernel,
                bounded_text(Path::new("/etc/os-release"), 65536).as_deref(),
            ),
            linux_environment(
                &kernel,
                Path::new("/.dockerenv").exists() || Path::new("/run/.containerenv").exists(),
                std::env::var_os("WSL_DISTRO_NAME").is_some_and(|s| !s.is_empty()),
            ),
        );
        #[cfg(not(target_os = "linux"))]
        let (os_version, environment) = (kernel, "native");
        Self {
            hostname: clean(&hostname, 64),
            os_version: clean(&os_version, 96),
            environment,
            version: std::env::current_exe()
                .ok()
                .as_deref()
                .and_then(installed_version),
        }
    }

    pub(crate) fn frame(&self, healthy: bool) -> String {
        let os = if cfg!(target_os = "macos") {
            "darwin"
        } else {
            std::env::consts::OS
        };
        let arch = match std::env::consts::ARCH {
            "x86_64" => "x64",
            "aarch64" => "arm64",
            other => other,
        };
        let mut value = json!({"kind":"device_info", "hostname":self.hostname,
            "os":os, "os_version":self.os_version, "arch":arch, "environment":self.environment,
            "capabilities": if healthy { vec!["read","file_write","shell"] } else { vec!["read"] }});
        if let Some(version) = &self.version {
            value["agent_version"] = json!(version);
        }
        value.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn report_matches_worker_bounds_and_runtime_mode() {
        let info = DeviceInfo::collect();
        for healthy in [true, false] {
            let frame = info.frame(healthy);
            let value: Value = serde_json::from_str(&frame).unwrap();
            assert_eq!(value["kind"], "device_info");
            assert!(frame.encode_utf16().count() <= 1200);
            assert_ne!(value["hostname"], "unknown");
            assert_ne!(value["os_version"], "unknown");
            assert_eq!(
                value["capabilities"],
                if healthy {
                    json!(["read", "file_write", "shell"])
                } else {
                    json!(["read"])
                }
            );
            assert!(value.get("upgrade_protocol").is_none());
        }
        assert_eq!(clean("  \u{0}a😀b\n", 3), "a😀");
        assert!(valid_version("v0.1.58-rust-candidate.4"));
        assert!(!valid_version("v0.1.58-"));
        assert!(!valid_version("0.0.0"));
    }

    #[test]
    fn version_comes_only_from_installed_bundle() {
        let root = tempfile::tempdir().unwrap();
        let exe = root.path().join("apps/remote-control-agent/.build/rca");
        std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
        std::fs::write(
            root.path().join("bundle.json"),
            r#"{"name":"remote-control-agent","version":"v0.1.58-rust-candidate.4"}"#,
        )
        .unwrap();
        assert_eq!(
            installed_version(&exe).as_deref(),
            Some("v0.1.58-rust-candidate.4")
        );
        assert_eq!(installed_version(&root.path().join("rca")), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn container_takes_precedence_and_distro_matches_node() {
        assert_eq!(
            linux_environment("6.18-microsoft-standard-WSL2", true, false),
            "container"
        );
        assert_eq!(
            linux_environment("6.18-microsoft-standard-WSL2", false, false),
            "wsl2"
        );
        assert_eq!(linux_environment("6.18-generic", false, true), "native");
        assert_eq!(
            linux_version(
                "6.18",
                Some("NAME=Ubuntu\nPRETTY_NAME=\"Ubuntu 24.04.3 LTS\"\n")
            ),
            "Ubuntu 24.04.3 LTS"
        );
        assert_eq!(linux_version("6.18", None), "6.18");
    }
}
