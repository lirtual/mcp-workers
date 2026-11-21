//! Nonproduction RCA Rust candidate. No production entrypoint or release integration.
//! Only publish after #914 Gate 0–3, independently authorized per platform.
#[cfg(target_os = "macos")]
pub mod darwin_supervisor;
pub mod digest;
pub mod gate0_probe;
pub mod identity;
#[cfg(target_os = "linux")]
pub mod linux_command;
#[cfg(target_os = "linux")]
pub mod linux_managed;
#[cfg(target_os = "linux")]
pub mod linux_output;
#[cfg(target_os = "linux")]
pub mod linux_supervisor;
pub mod native_browse;
pub mod native_file;
#[cfg(target_os = "linux")]
pub mod native_process;
pub mod native_read;
mod native_search;
pub mod native_write;
pub mod receipts;
pub mod session;
#[cfg(windows)]
mod windows_private;
