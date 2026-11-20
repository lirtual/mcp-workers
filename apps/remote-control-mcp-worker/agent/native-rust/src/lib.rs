//! Nonproduction RCA Rust candidate. No production entrypoint or release integration.
//! Only publish after #914 Gate 0–3, independently authorized per platform.
pub mod digest;
pub mod gate0_probe;
pub mod identity;
pub mod native_browse;
pub mod native_read;
pub mod receipts;
pub mod session;
