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
#[cfg(windows)]
pub mod windows_job;
#[cfg(windows)]
pub mod windows_managed;
#[cfg(windows)]
pub mod windows_output;
#[cfg(windows)]
mod windows_private;

/// Reuse the Windows NTFS handle/ACL guard for the unshipped CLI boundary.
/// This is validation only: no path is created or re-owned by this call.
#[cfg(windows)]
pub fn validate_windows_private_path(
    path: &std::path::Path,
    is_dir: bool,
) -> Result<(), receipts::ReceiptError> {
    windows_private::private_path(path, is_dir)
}
