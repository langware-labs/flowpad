//! Authenticode verification (Windows): the uninstaller checks its own deferred-cleanup copy and
//! a legacy repaired runtime's interpreter. The launcher (`bin/flowpad-install.rs`) keeps its own
//! copy of the same check: its source stays frozen with its pinned, signed binary
//! (electron/signing/LAUNCHER.md).

use std::ffi::c_void;
use std::iter::once;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;

use windows::core::{GUID, PCWSTR, PWSTR};
use windows::Win32::Foundation::{HANDLE, HWND};
use windows::Win32::Security::Cryptography::{CertGetNameStringW, CERT_NAME_SIMPLE_DISPLAY_TYPE};
use windows::Win32::Security::WinTrust::{
    WTHelperGetProvSignerFromChain, WTHelperProvDataFromStateData, WinVerifyTrust, WINTRUST_ACTION_GENERIC_VERIFY_V2,
    WINTRUST_DATA, WINTRUST_DATA_0, WINTRUST_FILE_INFO, WTD_CACHE_ONLY_URL_RETRIEVAL, WTD_CHOICE_FILE, WTD_REVOKE_NONE,
    WTD_STATEACTION_CLOSE, WTD_STATEACTION_VERIFY, WTD_UICONTEXT_EXECUTE, WTD_UI_NONE,
};

fn wide(s: &std::ffi::OsStr) -> Vec<u16> {
    s.encode_wide().chain(once(0)).collect()
}

/// Verify the file's Authenticode signature with the default policy (chain must reach a trusted
/// root; an expired leaf is fine when the signature is timestamped) and return the signer
/// certificate's simple display name (its subject CN). `what` names the file in error messages.
pub fn verify(path: &Path, what: &str) -> Result<String, String> {
    let file_w = wide(path.as_os_str());
    let mut file_info = WINTRUST_FILE_INFO {
        cbStruct: std::mem::size_of::<WINTRUST_FILE_INFO>() as u32,
        pcwszFilePath: PCWSTR(file_w.as_ptr()),
        hFile: HANDLE::default(),
        pgKnownSubject: std::ptr::null_mut(),
    };
    let mut data = WINTRUST_DATA {
        cbStruct: std::mem::size_of::<WINTRUST_DATA>() as u32,
        pPolicyCallbackData: std::ptr::null_mut(),
        pSIPClientData: std::ptr::null_mut(),
        dwUIChoice: WTD_UI_NONE,
        fdwRevocationChecks: WTD_REVOKE_NONE,
        dwUnionChoice: WTD_CHOICE_FILE,
        Anonymous: WINTRUST_DATA_0 { pFile: &mut file_info },
        dwStateAction: WTD_STATEACTION_VERIFY,
        hWVTStateData: HANDLE::default(),
        pwszURLReference: PWSTR::null(),
        dwProvFlags: WTD_CACHE_ONLY_URL_RETRIEVAL,
        dwUIContext: WTD_UICONTEXT_EXECUTE,
        pSignatureSettings: std::ptr::null_mut(),
    };
    let mut action: GUID = WINTRUST_ACTION_GENERIC_VERIFY_V2;

    // SAFETY: all pointers reference live locals for the duration of both calls;
    // the state handle is released with WTD_STATEACTION_CLOSE below on every path.
    unsafe {
        let status = WinVerifyTrust(HWND::default(), &mut action, &mut data as *mut _ as *mut c_void);
        let result = if status == 0 {
            signer_display_name(data.hWVTStateData, what)
        } else {
            Err(format!("{what}'s signature is not trusted (WinVerifyTrust 0x{:08x})", status as u32))
        };
        data.dwStateAction = WTD_STATEACTION_CLOSE;
        let _ = WinVerifyTrust(HWND::default(), &mut action, &mut data as *mut _ as *mut c_void);
        result
    }
}

unsafe fn signer_display_name(state: HANDLE, what: &str) -> Result<String, String> {
    let prov = WTHelperProvDataFromStateData(state);
    if prov.is_null() {
        return Err("cannot read signature data".to_string());
    }
    let signer = WTHelperGetProvSignerFromChain(prov, 0, false, 0);
    if signer.is_null() || (*signer).csCertChain == 0 || (*signer).pasCertChain.is_null() {
        return Err(format!("{what} carries no signer certificate"));
    }
    // pasCertChain[0] is the end-entity (signer) certificate.
    let cert = (*(*signer).pasCertChain).pCert;
    if cert.is_null() {
        return Err(format!("{what} carries no signer certificate"));
    }
    let mut buf = vec![0u16; 256];
    let len = CertGetNameStringW(cert, CERT_NAME_SIMPLE_DISPLAY_TYPE, 0, None, Some(buf.as_mut_slice()));
    if len <= 1 {
        return Err("cannot read the signer's name".to_string());
    }
    Ok(String::from_utf16_lossy(&buf[..(len as usize - 1)]))
}
