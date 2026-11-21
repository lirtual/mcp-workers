//! Windows owner-private receipt paths, checked through the actual file handle.
//! A permissive, redirected, malformed or unowned ACL is never accepted.
//! Node's sealed parent may protect the DACL while a receipts child inherits it.
#![cfg(windows)]

use crate::receipts::ReceiptError;
use std::ffi::c_void;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::{Component, Path, Prefix};
use std::ptr::{null, null_mut};
use windows_sys::Win32::Foundation::{LocalFree, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Security::Authorization::{
    GetSecurityInfo, SetSecurityInfo, SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::{
    AclSizeInformation, CreateWellKnownSid, EqualSid, GetAce, GetAclInformation,
    GetSecurityDescriptorControl, GetTokenInformation, IsValidSid, TokenUser, WinLocalSystemSid,
    ACCESS_ALLOWED_ACE, ACL, ACL_SIZE_INFORMATION, DACL_SECURITY_INFORMATION,
    OWNER_SECURITY_INFORMATION, PSID, SE_DACL_PROTECTED, TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_ALL_ACCESS,
    FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ,
    FILE_SHARE_WRITE, OPEN_EXISTING, READ_CONTROL, WRITE_OWNER,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

fn unsafe_path() -> ReceiptError {
    ReceiptError::UnsafePath
}

struct LocalDescriptor(*mut c_void);

impl Drop for LocalDescriptor {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { LocalFree(self.0) };
        }
    }
}

fn current_user_sid() -> Result<Vec<usize>, ReceiptError> {
    let mut token = null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(unsafe_path());
    }
    let token = unsafe { OwnedHandle::from_raw_handle(token) };
    let mut length = 0u32;
    unsafe { GetTokenInformation(token.as_raw_handle(), TokenUser, null_mut(), 0, &mut length) };
    if length == 0 || length > 4096 {
        return Err(unsafe_path());
    }
    // TOKEN_USER contains pointers. Allocate aligned storage, not Vec<u8>.
    let count = (length as usize).div_ceil(std::mem::size_of::<usize>());
    let mut bytes = vec![0usize; count];
    if unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            bytes.as_mut_ptr().cast(),
            length,
            &mut length,
        )
    } == 0
    {
        return Err(unsafe_path());
    }
    let sid = unsafe { (*(bytes.as_ptr().cast::<TOKEN_USER>())).User.Sid };
    if sid.is_null() || unsafe { IsValidSid(sid) } == 0 {
        return Err(unsafe_path());
    }
    Ok(bytes)
}

fn system_sid() -> Result<[usize; 16], ReceiptError> {
    let mut storage = [0usize; 16];
    let mut size = std::mem::size_of_val(&storage) as u32;
    if unsafe {
        CreateWellKnownSid(
            WinLocalSystemSid,
            null_mut(),
            storage.as_mut_ptr().cast(),
            &mut size,
        )
    } == 0
    {
        return Err(unsafe_path());
    }
    Ok(storage)
}

fn open_with_access(path: &Path, access: u32) -> Result<OwnedHandle, ReceiptError> {
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    if wide[..wide.len() - 1].contains(&0) {
        return Err(unsafe_path());
    }
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            access,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(unsafe_path());
    }
    Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}

fn open_read_control(path: &Path) -> Result<OwnedHandle, ReceiptError> {
    open_with_access(path, READ_CONTROL | FILE_READ_ATTRIBUTES)
}

/// Only the caller that successfully created this exact new path may seal it.
/// Existing Agent state must never be silently re-owned or have its DACL reset.
pub(crate) fn seal_new_owner(path: &Path, is_dir: bool) -> Result<(), ReceiptError> {
    private_path(path.parent().ok_or(ReceiptError::UnsafePath)?, true)?;
    let storage = current_user_sid()?;
    let user = unsafe { (*(storage.as_ptr().cast::<TOKEN_USER>())).User.Sid };
    let handle = open_with_access(path, READ_CONTROL | FILE_READ_ATTRIBUTES | WRITE_OWNER)?;
    let flags = attributes(&handle)?;
    if flags & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || (flags & FILE_ATTRIBUTE_DIRECTORY != 0) != is_dir
    {
        return Err(unsafe_path());
    }
    if unsafe {
        SetSecurityInfo(
            handle.as_raw_handle(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION,
            user,
            null_mut(),
            null(),
            null(),
        )
    } != 0
    {
        return Err(unsafe_path());
    }
    Ok(())
}

fn attributes(handle: &OwnedHandle) -> Result<u32, ReceiptError> {
    let mut metadata: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(handle.as_raw_handle(), &mut metadata) } == 0 {
        return Err(unsafe_path());
    }
    Ok(metadata.dwFileAttributes)
}

fn validated_acl(handle: &OwnedHandle, user: PSID, system: PSID) -> Result<bool, ReceiptError> {
    let mut owner: PSID = null_mut();
    let mut dacl: *mut ACL = null_mut();
    let mut descriptor = null_mut();
    let result = unsafe {
        GetSecurityInfo(
            handle.as_raw_handle(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            &mut dacl,
            null_mut(),
            &mut descriptor,
        )
    };
    if result != 0 {
        return Err(unsafe_path());
    }
    let descriptor = LocalDescriptor(descriptor);
    if descriptor.0.is_null()
        || owner.is_null()
        || dacl.is_null()
        || unsafe { EqualSid(owner, user) } == 0
    {
        return Err(unsafe_path());
    }

    let mut control = 0u16;
    let mut revision = 0u32;
    if unsafe { GetSecurityDescriptorControl(descriptor.0, &mut control, &mut revision) } == 0 {
        return Err(unsafe_path());
    }
    let mut info = ACL_SIZE_INFORMATION::default();
    if unsafe {
        GetAclInformation(
            dacl,
            (&mut info as *mut ACL_SIZE_INFORMATION).cast(),
            std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
            AclSizeInformation,
        )
    } == 0
    {
        return Err(unsafe_path());
    }
    let mut owner_full = false;
    for i in 0..info.AceCount {
        let mut raw_ace = null_mut();
        if unsafe { GetAce(dacl, i, &mut raw_ace) } == 0 || raw_ace.is_null() {
            return Err(unsafe_path());
        }
        let ace = unsafe { &*(raw_ace.cast::<ACCESS_ALLOWED_ACE>()) };
        // Refuse deny, callback, unknown and malformed ACEs: never guess grants.
        if ace.Header.AceType != 0
            || (ace.Header.AceSize as usize) < std::mem::size_of::<ACCESS_ALLOWED_ACE>()
        {
            return Err(unsafe_path());
        }
        let sid = (&ace.SidStart as *const u32).cast_mut().cast::<c_void>();
        if unsafe { IsValidSid(sid) } == 0 {
            return Err(unsafe_path());
        }
        if unsafe { EqualSid(sid, user) } != 0 {
            owner_full |= ace.Mask & FILE_ALL_ACCESS == FILE_ALL_ACCESS;
        } else if unsafe { EqualSid(sid, system) } == 0 {
            return Err(unsafe_path());
        }
    }
    if !owner_full {
        return Err(unsafe_path());
    }
    Ok(control & SE_DACL_PROTECTED != 0)
}

/// Accept only current-user-owned, user/SYSTEM-only ACLs. Inherited receipts
/// children are permitted if every parent up to a protected private anchor
/// obeys the same ACL; a broad or redirected ancestor always fails closed.
pub(crate) fn private_path(path: &Path, is_dir: bool) -> Result<(), ReceiptError> {
    if !path.is_absolute()
        || !matches!(
            path.components().next(),
            Some(Component::Prefix(p))
                if matches!(p.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_))
        )
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err(unsafe_path());
    }
    let user_storage = current_user_sid()?;
    let user = unsafe { (*(user_storage.as_ptr().cast::<TOKEN_USER>())).User.Sid };
    let system_storage = system_sid()?;
    let system = system_storage.as_ptr().cast_mut().cast::<c_void>();

    // Inspect each component by handle, so an ancestor junction cannot redirect
    // the later ACL/SQLite operations outside the expected private tree.
    for ancestor in path.ancestors() {
        if ancestor.as_os_str().is_empty() {
            continue;
        }
        let handle = open_read_control(ancestor)?;
        let flags = attributes(&handle)?;
        if flags & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(unsafe_path());
        }
    }

    let mut cursor = path;
    let mut expected_dir = is_dir;
    loop {
        let handle = open_read_control(cursor)?;
        let flags = attributes(&handle)?;
        if (flags & FILE_ATTRIBUTE_DIRECTORY != 0) != expected_dir {
            return Err(unsafe_path());
        }
        if validated_acl(&handle, user, system)? {
            return Ok(());
        }
        cursor = cursor.parent().ok_or_else(unsafe_path)?;
        expected_dir = true;
    }
}
