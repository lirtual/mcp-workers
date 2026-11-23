//! Nonproduction RCA Rust candidate. No production entrypoint or release integration.
//! Only publish after #914 Gate 0–3, independently authorized per platform.
#[cfg(target_os = "macos")]
#[path = "unix_managed.rs"]
pub mod darwin_managed;
#[cfg(target_os = "macos")]
#[path = "unix_output.rs"]
pub mod darwin_output;
#[cfg(target_os = "macos")]
pub mod darwin_supervisor;
pub mod digest;
pub mod gate0_probe;
pub mod identity;
#[cfg(target_os = "linux")]
pub mod linux_command;
#[cfg(target_os = "linux")]
#[path = "unix_managed.rs"]
pub mod linux_managed;
#[cfg(target_os = "linux")]
#[path = "unix_output.rs"]
pub mod linux_output;
#[cfg(target_os = "linux")]
pub mod linux_supervisor;
pub mod native_browse;
pub mod native_file;
#[cfg(any(target_os = "linux", target_os = "macos", windows))]
pub mod native_process;
pub mod native_read;
mod native_search;
pub mod native_write;
pub mod receipts;
pub mod session;
pub mod session_enrollment;
pub mod session_recovery;
pub mod session_registration;
#[cfg(target_os = "linux")]
pub mod session_runner;
pub mod session_transport_env;
#[cfg(unix)]
pub mod upgrade_control;
#[cfg(windows)]
pub mod windows_job;
#[cfg(windows)]
pub mod windows_managed;
#[cfg(windows)]
pub mod windows_output;
#[cfg(windows)]
mod windows_private;
#[cfg(windows)]
pub mod windows_session_runner;
#[cfg(windows)]
pub mod windows_upgrade_control;

/// Reuse the Windows NTFS handle/ACL guard for the unshipped CLI boundary.
/// This is validation only: no path is created or re-owned by this call.
#[cfg(windows)]
pub fn validate_windows_private_path(
    path: &std::path::Path,
    is_dir: bool,
) -> Result<(), receipts::ReceiptError> {
    windows_private::private_path(path, is_dir)
}

/// Reject the Windows LocalSystem account for a user-paired Standard Agent.
#[cfg(windows)]
pub fn is_windows_system_identity() -> Result<bool, receipts::ReceiptError> {
    windows_private::is_system_account()
}
