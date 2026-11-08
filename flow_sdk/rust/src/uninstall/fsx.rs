//! Windows file primitives for the uninstaller: no-follow handles, children opened relative to
//! their parent's handle, deletion by handle. Every rule here was proven on a Windows VM in the
//! FLOWPAD-2250 Phase 0 checks; the comments name the failure each one prevents.

use std::ffi::OsString;
use std::io;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};

use windows::core::{PCWSTR, PWSTR};
use windows::Wdk::Foundation::OBJECT_ATTRIBUTES;
use windows::Wdk::Storage::FileSystem::{
    NtCreateFile, FILE_OPEN, FILE_OPEN_REPARSE_POINT as NT_FILE_OPEN_REPARSE_POINT, FILE_SYNCHRONOUS_IO_NONALERT,
};
use windows::Win32::Foundation::{CloseHandle, BOOLEAN, HANDLE, UNICODE_STRING};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FileAttributeTagInfo, FileDispositionInfo, FileDispositionInfoEx, FileFullDirectoryInfo,
    FileFullDirectoryRestartInfo, GetFileInformationByHandle, GetFileInformationByHandleEx, GetFinalPathNameByHandleW,
    GetLongPathNameW, SetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, DELETE, FILE_ACCESS_RIGHTS,
    FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO, FILE_DISPOSITION_FLAG_DELETE,
    FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE, FILE_DISPOSITION_FLAG_POSIX_SEMANTICS, FILE_DISPOSITION_INFO,
    FILE_DISPOSITION_INFO_EX, FILE_DISPOSITION_INFO_EX_FLAGS, FILE_FLAGS_AND_ATTRIBUTES, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_FULL_DIR_INFO, FILE_LIST_DIRECTORY, FILE_NAME_NORMALIZED, FILE_READ_ATTRIBUTES,
    FILE_SHARE_DELETE, FILE_SHARE_MODE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING, SYNCHRONIZE,
};
use windows::Win32::System::IO::IO_STATUS_BLOCK;

const STATUS_ACCESS_DENIED: i32 = 0xC000_0022_u32 as i32;
const OBJ_CASE_INSENSITIVE: u32 = 0x40;
const ERROR_NO_MORE_FILES: i32 = 18;

/// An owned Windows handle, closed on drop.
pub struct Handle(HANDLE);

impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

/// The NTSTATUS or Win32 error behind a failed operation, kept for reporting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OsError {
    Nt(i32),
    Win32(i32),
}

impl OsError {
    fn from_win(e: windows::core::Error) -> OsError {
        OsError::Win32(e.code().0 & 0xFFFF)
    }

    /// A sharing violation: someone holds the object open without sharing delete.
    pub fn is_locked(self) -> bool {
        matches!(self, OsError::Nt(s) if s == 0xC000_0043_u32 as i32)
            || matches!(self, OsError::Win32(32))
            || matches!(self, OsError::Nt(s) if s == 0xC000_0121_u32 as i32) // STATUS_CANNOT_DELETE (running image)
    }

    pub fn is_access_denied(self) -> bool {
        matches!(self, OsError::Nt(s) if s == STATUS_ACCESS_DENIED) || matches!(self, OsError::Win32(5))
    }

    pub fn is_dir_not_empty(self) -> bool {
        matches!(self, OsError::Win32(145)) || matches!(self, OsError::Nt(s) if s == 0xC000_0101_u32 as i32)
    }
}

impl std::fmt::Display for OsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OsError::Nt(s) => write!(f, "NTSTATUS {:#010x}", *s as u32),
            OsError::Win32(c) => write!(f, "{}", io::Error::from_raw_os_error(*c)),
        }
    }
}

fn wide(p: &Path) -> Vec<u16> {
    p.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
}

/// `p` made absolute with every 8.3 short component expanded. `GetTempPath` answers
/// `C:\Users\TEST11~1\…` for a profile name with a space; compared raw against a final path that
/// root is refused (Phase 0, P5). Expands names only: a junction in the path is still there.
pub fn long_lexical(p: &Path) -> io::Result<PathBuf> {
    let abs = std::path::absolute(p)?;
    let w = wide(&abs);
    let mut buf = vec![0u16; 32768];
    let n = unsafe { GetLongPathNameW(PCWSTR(w.as_ptr()), Some(&mut buf)) } as usize;
    if n == 0 || n > buf.len() {
        return Err(io::Error::last_os_error());
    }
    Ok(PathBuf::from(OsString::from_wide(&buf[..n])))
}

/// Opens `path` itself, never a reparse target. With `hold`, nobody else may rename or delete it
/// while the handle lives. The handle must carry a data right (FILE_LIST_DIRECTORY): Windows does
/// not check share modes for attribute-only handles, so such a "hold" locks nothing (Phase 0, P3).
pub fn open_path_no_follow(path: &Path, hold: bool) -> Result<Handle, OsError> {
    let w = wide(path);
    let mut share: FILE_SHARE_MODE = FILE_SHARE_READ | FILE_SHARE_WRITE;
    if !hold {
        share = share | FILE_SHARE_DELETE;
    }
    let h = unsafe {
        CreateFileW(
            PCWSTR(w.as_ptr()),
            FILE_READ_ATTRIBUTES.0 | FILE_LIST_DIRECTORY.0 | SYNCHRONIZE.0,
            share,
            None,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            HANDLE::default(),
        )
    }
    .map_err(OsError::from_win)?;
    Ok(Handle(h))
}

/// Opens `path` itself (no follow) with DELETE, sharing everything — to remove an emptied root
/// after its identity is checked on this handle.
pub fn open_path_for_delete(path: &Path) -> Result<Handle, OsError> {
    let w = wide(path);
    let h = unsafe {
        CreateFileW(
            PCWSTR(w.as_ptr()),
            DELETE.0 | FILE_READ_ATTRIBUTES.0 | SYNCHRONIZE.0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            None,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            HANDLE::default(),
        )
    }
    .map_err(OsError::from_win)?;
    Ok(Handle(h))
}

/// Opens the child `name` of the directory behind `parent`, relative to that handle, never
/// following a reparse point. Never FILE_OPEN_FOR_BACKUP_INTENT: with SeRestorePrivilege enabled
/// (an elevated session) it grants DELETE over a deny ACE (Phase 0, P4).
pub fn open_child(parent: &Handle, name: &[u16], list: bool) -> Result<Handle, OsError> {
    let len = (name.len() * 2) as u16;
    let us = UNICODE_STRING { Length: len, MaximumLength: len, Buffer: PWSTR(name.as_ptr() as *mut u16) };
    let oa = OBJECT_ATTRIBUTES {
        Length: std::mem::size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: parent.0,
        ObjectName: &us,
        Attributes: OBJ_CASE_INSENSITIVE,
        SecurityDescriptor: std::ptr::null(),
        SecurityQualityOfService: std::ptr::null(),
    };
    let mut access = DELETE.0 | FILE_READ_ATTRIBUTES.0 | SYNCHRONIZE.0;
    if list {
        access |= FILE_LIST_DIRECTORY.0;
    }
    let mut h = HANDLE::default();
    let mut iosb = IO_STATUS_BLOCK::default();
    let st = unsafe {
        NtCreateFile(
            &mut h,
            FILE_ACCESS_RIGHTS(access),
            &oa,
            &mut iosb,
            None,
            FILE_FLAGS_AND_ATTRIBUTES(0),
            // No FILE_SHARE_DELETE: while we hold a directory nobody can move it out from under us.
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            FILE_OPEN,
            NT_FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
            None,
            0,
        )
    };
    if st.is_err() {
        Err(OsError::Nt(st.0))
    } else {
        Ok(Handle(h))
    }
}

/// [`open_child`] asking to list it when possible: a file whose ACL denies reading still opens
/// for deletion.
pub fn open_child_for_delete(parent: &Handle, name: &[u16]) -> Result<Handle, OsError> {
    match open_child(parent, name, true) {
        Err(OsError::Nt(s)) if s == STATUS_ACCESS_DENIED => open_child(parent, name, false),
        other => other,
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Attrs {
    pub directory: bool,
    pub reparse: bool,
}

/// The attributes of the object behind the handle — authoritative, unlike a directory listing
/// read before the open.
pub fn attrs(h: &Handle) -> Result<Attrs, OsError> {
    let mut info = FILE_ATTRIBUTE_TAG_INFO::default();
    unsafe {
        GetFileInformationByHandleEx(
            h.0,
            FileAttributeTagInfo,
            &mut info as *mut _ as *mut core::ffi::c_void,
            std::mem::size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
    }
    .map_err(OsError::from_win)?;
    Ok(Attrs {
        directory: info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 != 0,
        reparse: info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0,
    })
}

/// Volume serial number and file index: what identifies one file-system object across renames.
/// Matches Node's `fs.statSync(p, { bigint: true })` `dev` / `ino` (verified on the VM).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Identity {
    pub volume: u32,
    pub file_id: u64,
}

pub fn identity(h: &Handle) -> Result<Identity, OsError> {
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    unsafe { GetFileInformationByHandle(h.0, &mut info) }.map_err(OsError::from_win)?;
    Ok(Identity {
        volume: info.dwVolumeSerialNumber,
        file_id: ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
    })
}

/// The path the handle's object really lives at, with every junction and symlink resolved.
pub fn final_path(h: &Handle) -> Result<PathBuf, OsError> {
    let mut buf = vec![0u16; 32768];
    let n = unsafe { GetFinalPathNameByHandleW(h.0, &mut buf, FILE_NAME_NORMALIZED) } as usize;
    if n == 0 || n > buf.len() {
        return Err(OsError::Win32(io::Error::last_os_error().raw_os_error().unwrap_or(0)));
    }
    let s = OsString::from_wide(&buf[..n]);
    let s = s.to_string_lossy();
    Ok(PathBuf::from(s.strip_prefix(r"\\?\").unwrap_or(&s)))
}

pub fn same_path(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| {
        let s = p.to_string_lossy();
        let s = s.strip_prefix(r"\\?\").unwrap_or(&s).trim_end_matches('\\').to_lowercase();
        s
    };
    norm(a) == norm(b)
}

/// The names in the directory behind `h` (not `.` / `..`).
pub fn list_dir(h: &Handle) -> Result<Vec<Vec<u16>>, OsError> {
    let mut out = Vec::new();
    let mut buf = vec![0u64; 8192];
    let bytes = (buf.len() * 8) as u32;
    let mut first = true;
    loop {
        let class = if first { FileFullDirectoryRestartInfo } else { FileFullDirectoryInfo };
        first = false;
        let r = unsafe { GetFileInformationByHandleEx(h.0, class, buf.as_mut_ptr() as *mut core::ffi::c_void, bytes) };
        if let Err(e) = r {
            if e.code().0 & 0xFFFF == ERROR_NO_MORE_FILES {
                break;
            }
            return Err(OsError::from_win(e));
        }
        let base = buf.as_ptr() as *const u8;
        let mut off = 0usize;
        loop {
            let entry = unsafe { &*(base.add(off) as *const FILE_FULL_DIR_INFO) };
            let name = unsafe { std::slice::from_raw_parts(entry.FileName.as_ptr(), (entry.FileNameLength / 2) as usize) };
            if name != [b'.' as u16] && name != [b'.' as u16, b'.' as u16] {
                out.push(name.to_vec());
            }
            if entry.NextEntryOffset == 0 {
                break;
            }
            off += entry.NextEntryOffset as usize;
        }
    }
    Ok(out)
}

/// Delete the object behind the handle — a file, an empty directory, or a reparse point itself.
/// POSIX semantics where the file system has them (the name goes at once, even when others hold
/// the file open with share-delete); the classic disposition on FAT.
pub fn delete_by_handle(h: &Handle) -> Result<(), OsError> {
    let ex = FILE_DISPOSITION_INFO_EX {
        Flags: FILE_DISPOSITION_INFO_EX_FLAGS(
            FILE_DISPOSITION_FLAG_DELETE.0
                | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS.0
                | FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE.0,
        ),
    };
    let r = unsafe {
        SetFileInformationByHandle(
            h.0,
            FileDispositionInfoEx,
            &ex as *const _ as *const core::ffi::c_void,
            std::mem::size_of_val(&ex) as u32,
        )
    };
    match r {
        Ok(()) => Ok(()),
        Err(e) if matches!(e.code().0 & 0xFFFF, 1 | 50 | 87) => {
            let classic = FILE_DISPOSITION_INFO { DeleteFile: BOOLEAN(1) };
            unsafe {
                SetFileInformationByHandle(
                    h.0,
                    FileDispositionInfo,
                    &classic as *const _ as *const core::ffi::c_void,
                    std::mem::size_of_val(&classic) as u32,
                )
            }
            .map_err(OsError::from_win)
        }
        Err(e) => Err(OsError::from_win(e)),
    }
}

pub fn name_to_path(name: &[u16]) -> PathBuf {
    PathBuf::from(OsString::from_wide(name))
}

pub fn path_to_name(name: &str) -> Vec<u16> {
    name.encode_utf16().collect()
}
