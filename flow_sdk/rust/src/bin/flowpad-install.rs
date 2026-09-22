//! flowpad-install — the permanent Windows launcher shipped as `Flowpad-Setup.exe`.
//!
//! Why it exists (electron/signing/SMARTSCREEN-PLAN.md, phase 1): Microsoft Defender
//! SmartScreen scores a browser-downloaded file by its hash's download history, so a
//! versioned installer starts from zero on every release. This binary's bytes never
//! change between releases, so its reputation, once earned, carries over. It downloads
//! the real, versioned NSIS installer itself — a file written by a local process carries
//! no Mark-of-the-Web and is never evaluated by SmartScreen — verifies it, and runs it.
//!
//! Trust model, deliberately strict: the payload must match the SHA-512 published in
//! the release's `latest.yml` (the same feed electron-updater trusts) AND carry a valid
//! Authenticode signature whose subject is the expected publisher. Anything else is
//! refused with a plain message and a link to the release page. No retries, no fallback
//! to an unverified file, no packing, no telemetry.
//!
//! Environment overrides (testing only; never set for users):
//!   FLOWPAD_RELEASE_BASE        base URL ending in "/" (default: the production release feed)
//!   FLOWPAD_EXPECTED_PUBLISHER  certificate subject CN (default: "Langware INC.")
//!   FLOWPAD_BOOTSTRAP_DIR       download directory (default: %LOCALAPPDATA%\Flowpad\bootstrap)
//!   FLOWPAD_DRY_RUN=1           stop after verification; do not start the installer

#![cfg_attr(all(windows, not(test)), windows_subsystem = "windows")]

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine;
use sha2::{Digest, Sha512};

const DEFAULT_RELEASE_BASE: &str = "https://github.com/langware-labs/flowpad/releases/latest/download/";
const DEFAULT_EXPECTED_PUBLISHER: &str = "Langware INC.";
const RELEASES_PAGE: &str = "https://github.com/langware-labs/flowpad/releases";
const USER_AGENT: &str = concat!("flowpad-install/", env!("CARGO_PKG_VERSION"));

// ---------------------------------------------------------------------------
// Portable core (unit-tested on every platform)
// ---------------------------------------------------------------------------

/// The three top-level keys of electron-builder's `latest.yml` we depend on.
#[derive(Debug, PartialEq, Eq)]
pub struct Feed {
    pub version: String,
    pub path: String,
    pub sha512_b64: String,
}

/// Minimal parser for electron-builder's `latest.yml`: only unindented `key: value`
/// lines count, so the per-file `sha512:` under `files:` (indented) is ignored and the
/// top-level `path:`/`sha512:` pair, which describe the same installer, are used.
pub fn parse_feed(yml: &str) -> Result<Feed, String> {
    let mut version = None;
    let mut path = None;
    let mut sha512 = None;
    for line in yml.lines() {
        if line.starts_with(' ') || line.starts_with('\t') || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else { continue };
        let value = value.trim().trim_matches('\'').trim_matches('"').to_string();
        match key.trim() {
            "version" => version = Some(value),
            "path" => path = Some(value),
            "sha512" => sha512 = Some(value),
            _ => {}
        }
    }
    let feed = Feed {
        version: version.ok_or("latest.yml has no top-level `version`")?,
        path: path.ok_or("latest.yml has no top-level `path`")?,
        sha512_b64: sha512.ok_or("latest.yml has no top-level `sha512`")?,
    };
    validate_asset_name(&feed.path)?;
    Ok(feed)
}

/// The feed's `path` becomes a URL segment and a local file name: keep it to a plain
/// `.exe` name with no separators, so a tampered feed cannot escape the download dir.
pub fn validate_asset_name(name: &str) -> Result<(), String> {
    let plain = !name.is_empty()
        && name.len() <= 128
        && name.ends_with(".exe")
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        && !name.starts_with('.');
    if plain {
        Ok(())
    } else {
        Err(format!("unexpected installer name in latest.yml: {name:?}"))
    }
}

/// Decode the feed's base64 SHA-512 (electron-builder publishes it base64-encoded).
pub fn decode_sha512(b64: &str) -> Result<[u8; 64], String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|e| format!("latest.yml sha512 is not valid base64: {e}"))?;
    <[u8; 64]>::try_from(bytes.as_slice()).map_err(|_| "latest.yml sha512 is not 64 bytes".to_string())
}

/// Stream `reader` into `dest`, hashing as we go; the file is kept only when the hash
/// equals `expected`. Returns the byte count.
pub fn write_verified<R: Read>(mut reader: R, dest: &Path, expected: &[u8; 64]) -> Result<u64, String> {
    let partial = dest.with_extension("partial");
    let mut file = fs::File::create(&partial).map_err(|e| format!("cannot create {}: {e}", partial.display()))?;
    let mut hasher = Sha512::new();
    let mut buf = [0u8; 1 << 16];
    let mut total = 0u64;
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("download interrupted: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        file.write_all(&buf[..n]).map_err(|e| format!("cannot write {}: {e}", partial.display()))?;
        total += n as u64;
    }
    file.sync_all().ok();
    drop(file);
    let actual = hasher.finalize();
    if actual.as_slice() != expected {
        let _ = fs::remove_file(&partial);
        return Err("the downloaded installer does not match the published checksum".to_string());
    }
    let _ = fs::remove_file(dest);
    fs::rename(&partial, dest).map_err(|e| format!("cannot finalize {}: {e}", dest.display()))?;
    Ok(total)
}

pub struct Config {
    pub release_base: String,
    pub expected_publisher: String,
    pub download_dir: PathBuf,
}

pub fn config() -> Config {
    let release_base = std::env::var("FLOWPAD_RELEASE_BASE").unwrap_or_else(|_| DEFAULT_RELEASE_BASE.to_string());
    let expected_publisher =
        std::env::var("FLOWPAD_EXPECTED_PUBLISHER").unwrap_or_else(|_| DEFAULT_EXPECTED_PUBLISHER.to_string());
    let download_dir = std::env::var_os("FLOWPAD_BOOTSTRAP_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("LOCALAPPDATA").map(|p| PathBuf::from(p).join("Flowpad").join("bootstrap")))
        .unwrap_or_else(|| std::env::temp_dir().join("flowpad-bootstrap"));
    Config { release_base, expected_publisher, download_dir }
}

fn agent() -> Result<ureq::Agent, String> {
    // Client configuration for a one-shot downloader of a ~100 MB file: fail a dead
    // connection instead of hanging forever, but never cut a slow-but-live transfer
    // (read timeout applies per read, not to the whole download). TLS is the platform
    // stack, so certificate trust follows the machine's root store.
    let tls = native_tls::TlsConnector::new().map_err(|e| format!("cannot initialise TLS: {e}"))?;
    Ok(ureq::AgentBuilder::new()
        .tls_connector(std::sync::Arc::new(tls))
        .timeout_connect(Duration::from_secs(30))
        .timeout_read(Duration::from_secs(120))
        .user_agent(USER_AGENT)
        .build())
}

fn fetch_text(agent: &ureq::Agent, url: &str) -> Result<String, String> {
    agent
        .get(url)
        .call()
        .map_err(|e| format!("cannot fetch {url}: {e}"))?
        .into_string()
        .map_err(|e| format!("cannot read {url}: {e}"))
}

pub struct Log(Option<fs::File>);
impl Log {
    pub fn open(dir: &Path) -> Log {
        let _ = fs::create_dir_all(dir);
        Log(fs::OpenOptions::new().create(true).append(true).open(dir.join("flowpad-install.log")).ok())
    }
    pub fn line(&mut self, msg: &str) {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        if let Some(f) = self.0.as_mut() {
            let _ = writeln!(f, "[{secs}] {msg}");
        }
        eprintln!("{msg}");
    }
}

/// The whole flow. Returns the path of the verified installer that was launched.
pub fn run(cfg: &Config, log: &mut Log) -> Result<PathBuf, String> {
    log.line(&format!("{USER_AGENT} starting; feed base {}", cfg.release_base));
    let agent = agent()?;

    let feed_url = format!("{}latest.yml", cfg.release_base);
    let feed = parse_feed(&fetch_text(&agent, &feed_url)?)?;
    let expected = decode_sha512(&feed.sha512_b64)?;
    log.line(&format!("latest version {} -> {}", feed.version, feed.path));

    fs::create_dir_all(&cfg.download_dir).map_err(|e| format!("cannot create {}: {e}", cfg.download_dir.display()))?;
    remove_old_installers(&cfg.download_dir, &feed.path);
    let dest = cfg.download_dir.join(&feed.path);

    let url = format!("{}{}", cfg.release_base, feed.path);
    let response = agent.get(&url).call().map_err(|e| format!("cannot download {url}: {e}"))?;
    let bytes = write_verified(response.into_reader(), &dest, &expected)?;
    log.line(&format!("downloaded {bytes} bytes, checksum OK: {}", dest.display()));

    let subject = platform::verify_authenticode(&dest)?;
    if subject != cfg.expected_publisher {
        let _ = fs::remove_file(&dest);
        return Err(format!("the installer is signed by \"{subject}\", expected \"{}\"", cfg.expected_publisher));
    }
    log.line(&format!("Authenticode OK: signed by {subject}"));

    if std::env::var_os("FLOWPAD_DRY_RUN").is_some() {
        log.line("dry run: verified installer NOT started");
        return Ok(dest);
    }
    platform::launch(&dest)?;
    log.line("installer launched");
    Ok(dest)
}

/// Keep the bootstrap dir small: drop previously downloaded installers (and partials)
/// except the one we are about to (re)use.
fn remove_old_installers(dir: &Path, keep: &str) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let is_installer = name.ends_with(".exe") || name.ends_with(".partial");
            if is_installer && name != keep {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Windows: Authenticode verification, launch, error dialog
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod platform {
    use std::ffi::c_void;
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    use windows::core::{GUID, PCWSTR, PWSTR};
    use windows::Win32::Foundation::{HANDLE, HWND};
    use windows::Win32::Security::Cryptography::{CertGetNameStringW, CERT_NAME_SIMPLE_DISPLAY_TYPE};
    use windows::Win32::Security::WinTrust::{
        WTHelperGetProvSignerFromChain, WTHelperProvDataFromStateData, WinVerifyTrust, WINTRUST_ACTION_GENERIC_VERIFY_V2,
        WINTRUST_DATA, WINTRUST_DATA_0, WINTRUST_FILE_INFO, WTD_CACHE_ONLY_URL_RETRIEVAL, WTD_CHOICE_FILE,
        WTD_REVOKE_NONE, WTD_STATEACTION_CLOSE, WTD_STATEACTION_VERIFY, WTD_UICONTEXT_EXECUTE, WTD_UI_NONE,
    };
    use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};

    fn wide(s: &std::ffi::OsStr) -> Vec<u16> {
        s.encode_wide().chain(once(0)).collect()
    }

    /// Verify the file's Authenticode signature with the default policy (chain must
    /// reach a trusted root; an expired leaf is fine when the signature is timestamped)
    /// and return the signer certificate's simple display name (its subject CN).
    pub fn verify_authenticode(path: &Path) -> Result<String, String> {
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
                signer_display_name(data.hWVTStateData)
            } else {
                Err(format!("the installer's signature is not trusted (WinVerifyTrust 0x{:08x})", status as u32))
            };
            data.dwStateAction = WTD_STATEACTION_CLOSE;
            let _ = WinVerifyTrust(HWND::default(), &mut action, &mut data as *mut _ as *mut c_void);
            result
        }
    }

    unsafe fn signer_display_name(state: HANDLE) -> Result<String, String> {
        let prov = WTHelperProvDataFromStateData(state);
        if prov.is_null() {
            return Err("cannot read signature data".to_string());
        }
        let signer = WTHelperGetProvSignerFromChain(prov, 0, false, 0);
        if signer.is_null() || (*signer).csCertChain == 0 || (*signer).pasCertChain.is_null() {
            return Err("the installer carries no signer certificate".to_string());
        }
        // pasCertChain[0] is the end-entity (signer) certificate.
        let cert = (*(*signer).pasCertChain).pCert;
        if cert.is_null() {
            return Err("the installer carries no signer certificate".to_string());
        }
        let mut buf = vec![0u16; 256];
        let len = CertGetNameStringW(cert, CERT_NAME_SIMPLE_DISPLAY_TYPE, 0, None, Some(buf.as_mut_slice()));
        if len <= 1 {
            return Err("cannot read the signer's name".to_string());
        }
        Ok(String::from_utf16_lossy(&buf[..(len as usize - 1)]))
    }

    pub fn launch(installer: &Path) -> Result<(), String> {
        std::process::Command::new(installer)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("cannot start {}: {e}", installer.display()))
    }

    pub fn show_error(text: &str) {
        let text_w = wide(std::ffi::OsStr::new(text));
        let title_w = wide(std::ffi::OsStr::new("Flowpad"));
        // SAFETY: both buffers are NUL-terminated and outlive the call.
        unsafe {
            MessageBoxW(HWND::default(), PCWSTR(text_w.as_ptr()), PCWSTR(title_w.as_ptr()), MB_OK | MB_ICONERROR);
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use std::path::Path;
    pub fn verify_authenticode(_path: &Path) -> Result<String, String> {
        Err("flowpad-install verifies Authenticode signatures and runs on Windows only".to_string())
    }
    pub fn launch(_installer: &Path) -> Result<(), String> {
        Err("flowpad-install runs installers on Windows only".to_string())
    }
    pub fn show_error(text: &str) {
        eprintln!("{text}");
    }
}

fn main() {
    let cfg = config();
    let mut log = Log::open(&cfg.download_dir);
    match run(&cfg, &mut log) {
        Ok(_) => std::process::exit(0),
        Err(e) => {
            log.line(&format!("FAILED: {e}"));
            platform::show_error(&format!(
                "Flowpad could not be installed.\n\n{e}\n\nYou can download the installer directly from\n{RELEASES_PAGE}"
            ));
            std::process::exit(1);
        }
    }
}

// ---------------------------------------------------------------------------
// Tests (portable parts; run on every platform with `cargo test --bin flowpad-install`)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    const SAMPLE_FEED: &str = "version: 0.2.43\nfiles:\n  - url: Flowpad-0.2.43-Setup.exe\n    sha512: c2hhNTEyIG9mIHRoZSBmaWxlIGVudHJ5\n    size: 96703432\npath: Flowpad-0.2.43-Setup.exe\nsha512: cvxS4bCbNiX4mMN4CcU+fO4hWxGP5hZ6/BXuM+He8n500se26tvNdwvpwSW+jTGJbNTzMfa85Q96LD6Nm95bXg==\nreleaseDate: '2026-09-07T18:23:06.903Z'\n";

    #[test]
    fn parses_top_level_keys_and_ignores_the_files_list() {
        let feed = parse_feed(SAMPLE_FEED).unwrap();
        assert_eq!(feed.version, "0.2.43");
        assert_eq!(feed.path, "Flowpad-0.2.43-Setup.exe");
        assert!(feed.sha512_b64.starts_with("cvxS4bCb"), "top-level sha512, not the indented one");
        assert_eq!(decode_sha512(&feed.sha512_b64).unwrap().len(), 64);
    }

    #[test]
    fn parses_the_current_unversioned_name_too() {
        let yml = SAMPLE_FEED.replace("Flowpad-0.2.43-Setup.exe", "Flowpad-Setup.exe");
        assert_eq!(parse_feed(&yml).unwrap().path, "Flowpad-Setup.exe");
    }

    #[test]
    fn rejects_feeds_missing_keys_or_with_unsafe_names() {
        assert!(parse_feed("version: 1\n").is_err());
        for bad in ["../evil.exe", "C:\\x.exe", "setup.msi", "", "Flowpad Setup.exe", ".exe"] {
            let yml = format!("version: 1\npath: {bad}\nsha512: {}\n", "A".repeat(88));
            assert!(parse_feed(&yml).is_err(), "should reject {bad:?}");
        }
        assert!(validate_asset_name("Flowpad-0.2.44-Setup.exe").is_ok());
    }

    #[test]
    fn sha512_decoding_rejects_wrong_lengths() {
        assert!(decode_sha512("aGVsbG8=").is_err());
        assert!(decode_sha512("not base64!").is_err());
    }

    #[test]
    fn write_verified_keeps_only_a_matching_download() {
        let dir = std::env::temp_dir().join(format!("flowpad-install-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let payload = b"pretend this is an installer".to_vec();
        let expected: [u8; 64] = Sha512::digest(&payload).into();
        let dest = dir.join("Flowpad-9.9.9-Setup.exe");

        let n = write_verified(Cursor::new(payload.clone()), &dest, &expected).unwrap();
        assert_eq!(n, payload.len() as u64);
        assert_eq!(fs::read(&dest).unwrap(), payload);
        assert!(!dest.with_extension("partial").exists());

        let mut wrong = payload.clone();
        wrong.push(b'!');
        let err = write_verified(Cursor::new(wrong), &dir.join("other.exe"), &expected).unwrap_err();
        assert!(err.contains("checksum"), "{err}");
        assert!(!dir.join("other.exe").exists() && !dir.join("other.partial").exists());

        remove_old_installers(&dir, "keep.exe");
        assert!(!dest.exists(), "old installers are cleaned up");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn end_to_end_against_a_local_http_server_stops_before_authenticode() {
        // Serves latest.yml and the "installer" from a throwaway HTTP/1.1 server, so
        // the fetch → parse → download → hash path is exercised for real. On
        // non-Windows the run must stop at the Authenticode step with a clear error;
        // on Windows it fails there too because the payload is not a signed PE.
        use std::io::{BufRead, BufReader};
        use std::net::TcpListener;

        let payload = b"not really a PE, but hashed and verified like one".to_vec();
        let sha = base64::engine::general_purpose::STANDARD.encode(Sha512::digest(&payload));
        let feed = format!("version: 9.9.9\npath: Flowpad-9.9.9-Setup.exe\nsha512: {sha}\n");

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/", listener.local_addr().unwrap());
        let served = payload.clone();
        let server = std::thread::spawn(move || {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request_line = String::new();
                reader.read_line(&mut request_line).unwrap();
                loop {
                    let mut h = String::new();
                    reader.read_line(&mut h).unwrap();
                    if h == "\r\n" || h.is_empty() { break; }
                }
                let body: Vec<u8> = if request_line.contains("latest.yml") { feed.as_bytes().to_vec() } else { served.clone() };
                let head = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                stream.write_all(head.as_bytes()).unwrap();
                stream.write_all(&body).unwrap();
            }
        });

        let dir = std::env::temp_dir().join(format!("flowpad-install-e2e-{}", std::process::id()));
        let cfg = Config { release_base: base, expected_publisher: "Langware INC.".into(), download_dir: dir.clone() };
        let mut log = Log(None);
        let err = run(&cfg, &mut log).unwrap_err();
        assert!(err.contains("Windows only") || err.contains("signature"), "stopped at Authenticode: {err}");
        assert_eq!(fs::read(dir.join("Flowpad-9.9.9-Setup.exe")).unwrap(), payload, "verified download landed");
        server.join().unwrap();
        fs::remove_dir_all(&dir).unwrap();
    }
}
