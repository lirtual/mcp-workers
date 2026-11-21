//! Nonproduction Windows process ownership proof for #914.
//! Only a SystemRoot PowerShell launched suspended can enter this private job;
//! no PID from the network is ever used for termination. Job handle closure
//! kills the owned CreateProcess tree; externally brokered processes (e.g. WMI)
//! are outside this proof and must not be claimed as cleaned up.
#![cfg(windows)]

use base64::Engine;
use std::io::{self, ErrorKind};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::MetadataExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::{Component, PathBuf, Prefix};
use std::ptr::{null, null_mut};
use std::thread;
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob,
    JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation,
    QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{
    CreateProcessW, GetExitCodeProcess, ResumeThread, TerminateProcess, WaitForSingleObject,
    CREATE_NO_WINDOW, CREATE_SUSPENDED, PROCESS_INFORMATION, STARTUPINFOW,
};

const MAX_COMMAND_UNITS: usize = 8192;
const MAX_KILL_WAIT: Duration = Duration::from_secs(5);

fn invalid(reason: &'static str) -> io::Error {
    io::Error::new(ErrorKind::InvalidInput, reason)
}

fn powershell() -> io::Result<PathBuf> {
    let system_root = std::env::var_os("SystemRoot")
        .ok_or_else(|| invalid("a local Windows SystemRoot is required"))?;
    let root = PathBuf::from(system_root);
    if !root.is_absolute()
        || !matches!(
            root.components().next(),
            Some(Component::Prefix(p))
                if matches!(p.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_))
        )
        || root
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(invalid("invalid Windows SystemRoot"));
    }
    let shell = root.join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let metadata = std::fs::symlink_metadata(&shell)?;
    if !metadata.is_file() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(invalid("untrusted Windows PowerShell executable"));
    }
    Ok(shell)
}

fn encoded_command(script: &str) -> io::Result<String> {
    if script.is_empty()
        || script.contains(char::from(0))
        || script.encode_utf16().take(MAX_COMMAND_UNITS + 1).count() > MAX_COMMAND_UNITS
    {
        return Err(invalid("invalid Windows managed command"));
    }
    // -EncodedCommand avoids shell-quote ambiguity while preserving Node's
    // Windows PowerShell -NoProfile -NonInteractive -Command semantics.
    let utf16le = script
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect::<Vec<_>>();
    Ok(base64::engine::general_purpose::STANDARD.encode(utf16le))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JobCleanup {
    /// The kernel reports zero active processes in this exact private job.
    Confirmed,
    /// A timeout left at least one process or the accounting state uncertain.
    Unknown,
}

/// Owns both the process HANDLE and the unnamed kill-on-close Job HANDLE.
/// The process is never resumed unless assignment to the private job succeeds.
pub struct WindowsJobSession {
    job: OwnedHandle,
    process: OwnedHandle,
}

impl WindowsJobSession {
    pub fn start(command: &str) -> io::Result<Self> {
        let encoded = encoded_command(command)?;
        let executable = powershell()?;
        let path = executable
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        if path[..path.len() - 1].contains(&0) {
            return Err(invalid("embedded NUL in PowerShell path"));
        }
        let mut command_line: Vec<u16> = vec![b'"' as u16];
        command_line.extend(executable.as_os_str().encode_wide());
        command_line.extend(
            format!("\" -NoLogo -NoProfile -NonInteractive -EncodedCommand {encoded}")
                .encode_utf16(),
        );
        command_line.push(0);

        let job = unsafe { CreateJobObjectW(null(), null()) };
        if job.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job = unsafe { OwnedHandle::from_raw_handle(job) };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if unsafe {
            SetInformationJobObject(
                job.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }

        let startup = STARTUPINFOW {
            cb: std::mem::size_of::<STARTUPINFOW>() as u32,
            ..Default::default()
        };
        let mut process_info = PROCESS_INFORMATION::default();
        if unsafe {
            CreateProcessW(
                path.as_ptr(),
                command_line.as_mut_ptr(),
                null(),
                null(),
                0,
                CREATE_NO_WINDOW | CREATE_SUSPENDED,
                null(),
                null(),
                &startup,
                &mut process_info,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let process = unsafe { OwnedHandle::from_raw_handle(process_info.hProcess) };
        let thread = unsafe { OwnedHandle::from_raw_handle(process_info.hThread) };
        if unsafe { AssignProcessToJobObject(job.as_raw_handle(), process.as_raw_handle()) } == 0 {
            let error = io::Error::last_os_error();
            // Before successful assignment the job does not own this suspended
            // process. Explicit termination is required on this failure path.
            unsafe { TerminateProcess(process.as_raw_handle(), 1) };
            return Err(error);
        }
        let mut assigned = 0;
        if unsafe { IsProcessInJob(process.as_raw_handle(), job.as_raw_handle(), &mut assigned) }
            == 0
            || assigned == 0
        {
            // Closing the job terminates the still-suspended associated child.
            return Err(io::Error::other("Windows process ownership unconfirmed"));
        }
        if unsafe { ResumeThread(thread.as_raw_handle()) } == u32::MAX {
            return Err(io::Error::last_os_error());
        }
        Ok(Self { job, process })
    }

    /// Reads kernel job accounting, not a stored or caller-provided numeric PID.
    pub fn active_processes(&self) -> io::Result<u32> {
        let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        if unsafe {
            QueryInformationJobObject(
                self.job.as_raw_handle(),
                JobObjectBasicAccountingInformation,
                (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                std::mem::size_of_val(&accounting) as u32,
                null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(accounting.ActiveProcesses)
    }

    /// A process exit does not prove descendant cleanup; the job may still
    /// contain children and stays owned until this session is dropped.
    pub fn wait_for_exit(&self, limit: Duration) -> io::Result<Option<u32>> {
        if limit > Duration::from_secs(60 * 60) {
            return Err(invalid("Windows command wait limit exceeds 60 minutes"));
        }
        // Win32 0xffffffff is INFINITE; never turn a caller timeout into it.
        let wait = limit.as_millis().min((u32::MAX - 1) as u128) as u32;
        match unsafe { WaitForSingleObject(self.process.as_raw_handle(), wait) } {
            WAIT_OBJECT_0 => {
                let mut exit_code = 0u32;
                if unsafe { GetExitCodeProcess(self.process.as_raw_handle(), &mut exit_code) } == 0
                {
                    return Err(io::Error::last_os_error());
                }
                Ok(Some(exit_code))
            }
            WAIT_TIMEOUT => Ok(None),
            _ => Err(io::Error::last_os_error()),
        }
    }

    /// Stop only the kernel job created by this session, and verify no active
    /// associated processes remain. Failure is Unknown, never a fake success.
    pub fn terminate_and_wait(&self, limit: Duration) -> io::Result<JobCleanup> {
        if limit.is_zero() || limit > MAX_KILL_WAIT {
            return Err(invalid(
                "Windows job cleanup limit must be at most five seconds",
            ));
        }
        if self.active_processes()? == 0 {
            return Ok(JobCleanup::Confirmed);
        }
        if unsafe { TerminateJobObject(self.job.as_raw_handle(), 1) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let deadline = Instant::now() + limit;
        loop {
            if self.active_processes()? == 0 {
                return Ok(JobCleanup::Confirmed);
            }
            if Instant::now() >= deadline {
                return Ok(JobCleanup::Unknown);
            }
            thread::sleep(Duration::from_millis(20));
        }
    }
}
