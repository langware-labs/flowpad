//! Windows platform helpers for the uninstaller: where things live, bounded child processes,
//! the registry values it reads and writes, and secure randomness.

use std::ffi::OsString;
use std::io::Read;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use windows::core::{GUID, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, ERROR_SUCCESS, HANDLE};
use windows::Win32::Security::Cryptography::{BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG};
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
    TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows::Win32::System::Registry::{
    RegCloseKey, RegDeleteValueW, RegGetValueW, RegOpenKeyExW, RegSetKeyValueW, HKEY, HKEY_CURRENT_USER,
    HKEY_LOCAL_MACHINE, KEY_READ, REG_SZ, RRF_RT_REG_DWORD, RRF_RT_REG_SZ,
};
use windows::Win32::UI::Shell::{
    FOLDERID_LocalAppData, FOLDERID_Profile, FOLDERID_RoamingAppData, SHGetKnownFolderPath, KF_FLAG_DEFAULT,
};

/// Where everything the uninstaller may touch lives. Resolved from the shell's known folders —
/// never from environment variables, which an empty or redirected value could point anywhere.
#[derive(Debug, Clone)]
pub struct Layout {
    pub local: PathBuf,
    pub roaming: PathBuf,
    pub profile: PathBuf,
    pub temp: PathBuf,
    pub install_dir: PathBuf,
}

fn known_folder(id: &GUID) -> Result<PathBuf, String> {
    unsafe {
        let p = SHGetKnownFolderPath(id, KF_FLAG_DEFAULT, HANDLE::default()).map_err(|e| e.to_string())?;
        let len = (0..).take_while(|&i| *p.0.add(i) != 0).count();
        let s = OsString::from_wide(std::slice::from_raw_parts(p.0, len));
        CoTaskMemFree(Some(p.0 as *const _));
        Ok(PathBuf::from(s))
    }
}

impl Layout {
    pub fn resolve(install_dir: &Path) -> Result<Layout, String> {
        // Debug builds only: point every folder into a scratch tree so the end-to-end tests never
        // touch a real installation. Release builds have no such switch.
        #[cfg(debug_assertions)]
        if let Ok(root) = std::env::var("FLOWRS_TEST_LAYOUT_ROOT") {
            let root = PathBuf::from(root);
            return Ok(Layout {
                local: root.join("local"),
                roaming: root.join("roaming"),
                profile: root.join("profile"),
                temp: root.join("temp"),
                install_dir: install_dir.to_path_buf(),
            });
        }
        Ok(Layout {
            local: known_folder(&FOLDERID_LocalAppData)?,
            roaming: known_folder(&FOLDERID_RoamingAppData)?,
            profile: known_folder(&FOLDERID_Profile)?,
            temp: std::env::temp_dir(),
            install_dir: install_dir.to_path_buf(),
        })
    }

    pub fn flow_home(&self) -> PathBuf {
        self.profile.join(".flow")
    }
    pub fn instances(&self) -> PathBuf {
        self.flow_home().join("instances")
    }
    pub fn uv_tools(&self) -> PathBuf {
        self.roaming.join("uv").join("tools")
    }
    pub fn venv(&self) -> PathBuf {
        self.uv_tools().join("flowpad")
    }
    pub fn local_flowpad(&self) -> PathBuf {
        self.local.join("Flowpad")
    }
    pub fn ownership_record(&self) -> PathBuf {
        self.local_flowpad().join("engine-ownership.json")
    }
    /// The record of the venv a runtime repair set aside (electron/engine-ownership.js).
    pub fn aside_ownership_record(&self) -> PathBuf {
        self.local_flowpad().join("engine-ownership.pre-repair.json")
    }
    pub fn pre_repair_venv(&self) -> PathBuf {
        self.uv_tools().join("flowpad.pre-repair")
    }
    pub fn runtime(&self) -> PathBuf {
        self.local_flowpad().join("runtime")
    }
    pub fn runtime_state(&self) -> PathBuf {
        self.flow_home().join(super::ops::RUNTIME_STATE_FILE)
    }
    pub fn bootstrap(&self) -> PathBuf {
        self.local_flowpad().join("bootstrap")
    }
    pub fn updater(&self) -> PathBuf {
        self.local.join("flowpad-updater")
    }
    pub fn app_data(&self) -> PathBuf {
        self.roaming.join("Flowpad")
    }
    pub fn local_bin(&self) -> PathBuf {
        self.profile.join(".local").join("bin")
    }
    pub fn helper_dir(&self) -> PathBuf {
        self.local_flowpad().join("fc")
    }
    pub fn app_exe(&self) -> PathBuf {
        self.install_dir.join("Flowpad.exe")
    }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// What a bounded child run produced.
#[derive(Debug)]
pub struct Ran {
    pub code: Option<i32>,
    pub timed_out: bool,
    pub output: String,
}

/// Run `exe` with a hard timeout. The child is placed in a Job object that kills it AND anything
/// it started when the job closes, so a hung `flow stop` cannot outlive its budget.
pub fn run_bounded(exe: &Path, args: &[&str], env: &[(&str, &str)], timeout: Duration) -> Result<Ran, String> {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let job = unsafe { CreateJobObjectW(None, PCWSTR::null()) }.map_err(|e| e.to_string())?;
    let job = Owned(job);
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    unsafe {
        SetInformationJobObject(
            job.0,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    }
    .map_err(|e| e.to_string())?;
    let mut cmd = Command::new(exe);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).creation_flags(CREATE_NO_WINDOW);
    for (k, v) in env {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().map_err(|e| format!("cannot start {}: {e}", exe.display()))?;
    let _ = unsafe { AssignProcessToJobObject(job.0, HANDLE(child.as_raw_handle())) };
    let mut out = child.stdout.take().unwrap();
    let mut err = child.stderr.take().unwrap();
    let t_out = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = out.read_to_string(&mut s);
        s
    });
    let t_err = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = err.read_to_string(&mut s);
        s
    });
    let deadline = Instant::now() + timeout;
    let mut timed_out = false;
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) if Instant::now() >= deadline => {
                timed_out = true;
                let _ = unsafe { TerminateJobObject(job.0, 1) };
                let _ = child.wait();
                break None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => return Err(e.to_string()),
        }
    };
    drop(job);
    let output = format!("{}{}", t_out.join().unwrap_or_default(), t_err.join().unwrap_or_default());
    Ok(Ran { code, timed_out, output })
}

struct Owned(HANDLE);
impl Drop for Owned {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

fn open_key(root: HKEY, path: &str) -> Option<HKEY> {
    let mut key = HKEY::default();
    let w = wide(path);
    (unsafe { RegOpenKeyExW(root, PCWSTR(w.as_ptr()), 0, KEY_READ, &mut key) } == ERROR_SUCCESS).then_some(key)
}

pub fn key_exists(root: HKEY, path: &str) -> bool {
    match open_key(root, path) {
        Some(k) => {
            let _ = unsafe { RegCloseKey(k) };
            true
        }
        None => false,
    }
}

pub fn read_dword(root: HKEY, path: &str, name: &str) -> Option<u32> {
    let (p, n) = (wide(path), wide(name));
    let mut v = 0u32;
    let mut size = 4u32;
    let rc = unsafe {
        RegGetValueW(root, PCWSTR(p.as_ptr()), PCWSTR(n.as_ptr()), RRF_RT_REG_DWORD, None, Some(&mut v as *mut _ as *mut _), Some(&mut size))
    };
    (rc == ERROR_SUCCESS).then_some(v)
}

pub fn read_string(root: HKEY, path: &str, name: &str) -> Option<String> {
    let (p, n) = (wide(path), wide(name));
    let mut buf = vec![0u16; 4096];
    let mut size = (buf.len() * 2) as u32;
    let rc = unsafe {
        RegGetValueW(root, PCWSTR(p.as_ptr()), PCWSTR(n.as_ptr()), RRF_RT_REG_SZ, None, Some(buf.as_mut_ptr() as *mut _), Some(&mut size))
    };
    if rc != ERROR_SUCCESS {
        return None;
    }
    let chars = (size as usize / 2).saturating_sub(1);
    Some(String::from_utf16_lossy(&buf[..chars]))
}

pub fn write_string(root: HKEY, path: &str, name: &str, value: &str) -> Result<(), String> {
    let (p, n, v) = (wide(path), wide(name), wide(value));
    let rc = unsafe {
        RegSetKeyValueW(root, PCWSTR(p.as_ptr()), PCWSTR(n.as_ptr()), REG_SZ.0, Some(v.as_ptr() as *const _), (v.len() * 2) as u32)
    };
    if rc == ERROR_SUCCESS {
        Ok(())
    } else {
        Err(format!("registry write failed ({})", rc.0))
    }
}

pub fn delete_value(root: HKEY, path: &str, name: &str) {
    if let Some(k) = open_key_writable(root, path) {
        let n = wide(name);
        let _ = unsafe { RegDeleteValueW(k, PCWSTR(n.as_ptr())) };
        let _ = unsafe { RegCloseKey(k) };
    }
}

fn open_key_writable(root: HKEY, path: &str) -> Option<HKEY> {
    use windows::Win32::System::Registry::KEY_SET_VALUE;
    let mut key = HKEY::default();
    let w = wide(path);
    (unsafe { RegOpenKeyExW(root, PCWSTR(w.as_ptr()), 0, KEY_SET_VALUE, &mut key) } == ERROR_SUCCESS).then_some(key)
}

pub const HKCU: HKEY = HKEY_CURRENT_USER;
pub const HKLM: HKEY = HKEY_LOCAL_MACHINE;

pub fn random_bytes<const N: usize>() -> Result<[u8; N], String> {
    let mut buf = [0u8; N];
    unsafe { BCryptGenRandom(None, &mut buf, BCRYPT_USE_SYSTEM_PREFERRED_RNG) }.ok().map_err(|e| e.to_string())?;
    Ok(buf)
}

/// Seconds since the Unix epoch.
pub fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

pub fn path_wide(p: &Path) -> Vec<u16> {
    p.as_os_str().encode_wide().collect()
}
