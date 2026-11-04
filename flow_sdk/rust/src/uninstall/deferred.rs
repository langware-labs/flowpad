//! The deferred cleanup (FLOWPAD-2250, plan §6–§7): what was in use during the uninstall is
//! removed at the next sign-in, by a copy of this signed binary started once from HKCU RunOnce.
//!
//! Scheduling is reported only when every step is verified: the copy's signature, the copy runs
//! from its folder (application-control policies), the state and its key were stored and read
//! back, the RunOnce value reads back exactly. RunOnce is never re-registered by the cleanup
//! itself (no loop); further triggers are the next FlowPad installer and the manual command.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::ops::{self, Leftover};
use super::report::{Item, Ledger, Log};
use super::state::{self, Body, Entry, RootId, Secret};
use super::win::{self, Layout, HKCU, HKLM};
use super::delete::Root;

const RUN_ONCE_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\RunOnce";
/// Debug builds under test use their own value, so a test never schedules a real cleanup.
fn run_once_value() -> &'static str {
    if cfg!(debug_assertions) && std::env::var_os("FLOWRS_TEST_LAYOUT_ROOT").is_some() {
        "FlowpadCleanupTest"
    } else {
        "FlowpadCleanup"
    }
}
const POLICY_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Policies\Explorer";
const CREDENTIAL_SERVICE: &str = if cfg!(debug_assertions) { "Flowpad.cleanup.debug" } else { "Flowpad.cleanup" };
const CREDENTIAL_ACCOUNT: &str = "state";
/// Microsoft documents a 260-character limit for Run/RunOnce command lines.
const MAX_RUN_ONCE_CHARS: usize = 259;
const HELPER_EXE: &str = "flow-rs.exe";
const STATE_FILE: &str = "state.json";
const STATUS_FILE: &str = "status.log";
pub const SELF_TEST_OK: &str = "flow-rs self-test ok";

fn credential() -> Result<keyring::Entry, String> {
    keyring::Entry::new(CREDENTIAL_SERVICE, CREDENTIAL_ACCOUNT).map_err(|e| e.to_string())
}

fn status(layout: &Layout, msg: &str) {
    use std::io::Write;
    let _ = fs::create_dir_all(layout.helper_dir());
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(layout.helper_dir().join(STATUS_FILE)) {
        let _ = writeln!(f, "[{}] {msg}", win::now());
    }
}

/// Unsigned debug builds may schedule themselves only when a test explicitly allows it; a
/// release build always requires a valid signature.
fn signature_ok(path: &Path) -> Result<(), String> {
    match crate::authenticode::verify(path, "the cleanup helper") {
        Ok(_) => Ok(()),
        Err(e) if cfg!(debug_assertions) && std::env::var("FLOWRS_TEST_ALLOW_UNSIGNED").as_deref() == Ok("1") => {
            let _ = e;
            Ok(())
        }
        Err(e) => Err(e),
    }
}

/// Undo a half-made schedule: nothing pending may be left that the summary did not report.
fn unschedule(layout: &Layout) {
    win::delete_value(HKCU, RUN_ONCE_KEY, run_once_value());
    if let Ok(c) = credential() {
        let _ = c.delete_credential();
    }
    let _ = fs::remove_file(layout.helper_dir().join(STATE_FILE));
    let _ = fs::remove_file(layout.helper_dir().join(HELPER_EXE));
}

/// Schedule the leftovers. On success they move to `ledger.pending`; otherwise to `ledger.left`
/// with the reason, and nothing is left registered.
pub fn schedule(layout: &Layout, leftovers: Vec<Leftover>, ledger: &mut Ledger, log: &mut Log) {
    if leftovers.is_empty() {
        return;
    }
    match try_schedule(layout, &leftovers) {
        Ok(()) => {
            log.line("deferred cleanup scheduled (RunOnce, helper signature, self-test, state and key verified)");
            status(layout, &format!("scheduled {} root(s)", leftovers.len()));
            for l in leftovers {
                ledger.pending.push(Item { what: format!("{:?}", l.root), path: l.path.display().to_string(), reason: l.detail });
            }
        }
        Err(reason) => {
            unschedule(layout);
            log.line(&format!("deferred cleanup NOT scheduled: {reason}"));
            for l in leftovers {
                ledger.left(&format!("{:?}", l.root), &l.path, &format!("{}; it could not be scheduled for removal: {reason}", l.detail));
            }
        }
    }
}

fn try_schedule(layout: &Layout, leftovers: &[Leftover]) -> Result<(), String> {
    for (root, path) in [(HKCU, POLICY_KEY), (HKLM, POLICY_KEY)] {
        if win::read_dword(root, path, "DisableCurrentUserRunOnce").unwrap_or(0) != 0 {
            return Err("a policy disables RunOnce for this user".into());
        }
    }
    let dir = layout.helper_dir();
    let helper = dir.join(HELPER_EXE);
    let command = format!("\"{}\" deferred-cleanup", helper.display());
    if command.chars().count() > MAX_RUN_ONCE_CHARS {
        return Err(format!("the cleanup command would be {} characters (RunOnce allows {MAX_RUN_ONCE_CHARS})", command.chars().count()));
    }
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let me = std::env::current_exe().map_err(|e| e.to_string())?;
    if !win_same(&me, &helper) {
        fs::copy(&me, &helper).map_err(|e| format!("cannot copy the cleanup helper: {e}"))?;
    }
    signature_ok(&helper)?;
    let ran = win::run_bounded(&helper, &["self-test"], &[], Duration::from_secs(15))?;
    if ran.code != Some(0) || !ran.output.contains(SELF_TEST_OK) {
        return Err(format!("the cleanup helper cannot run from {} (blocked by policy?)", dir.display()));
    }

    let key = win::random_bytes::<32>()?;
    let nonce = state::hex(&win::random_bytes::<16>()?);
    let secret = Secret { key, nonce: nonce.clone() };
    let now = win::now();
    let body = Body {
        schema: state::SCHEMA,
        nonce,
        created_at: now,
        expires_at: now + state::LIFETIME_SECS - 60,
        entries: leftovers.iter().map(|l| Entry { root: l.root, volume: l.identity.volume, file_id: l.identity.file_id }).collect(),
    };
    let text = state::to_text(&state::sign(body.clone(), &secret));
    credential()?.set_password(&secret.encode()).map_err(|e| format!("cannot store the cleanup key: {e}"))?;
    fs::write(dir.join(STATE_FILE), &text).map_err(|e| e.to_string())?;
    let stored = credential()?.get_password().ok().and_then(|s| Secret::decode(&s));
    let reread = fs::read_to_string(dir.join(STATE_FILE)).map_err(|e| e.to_string())?;
    if state::verify(&reread, stored.as_ref(), now).map_err(|e| e.to_string())? != body {
        return Err("the stored cleanup state does not read back".into());
    }
    win::write_string(HKCU, RUN_ONCE_KEY, run_once_value(), &command)?;
    if win::read_string(HKCU, RUN_ONCE_KEY, run_once_value()).as_deref() != Some(command.as_str()) {
        return Err("the RunOnce entry does not read back".into());
    }
    Ok(())
}

fn win_same(a: &Path, b: &Path) -> bool {
    a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy())
}

/// Who started the cleanup.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    /// RunOnce at sign-in.
    Logon,
    /// A new FlowPad installer, before the app's first launch.
    Installer,
    /// The user, by the documented command.
    Manual,
}

fn root_path(layout: &Layout, root: RootId, pinned: super::Identity) -> PathBuf {
    match root {
        RootId::Venv => layout.venv(),
        // Not rebuilt from desktop-runtime.json's `version`: a repair that failed after marking its
        // folder leaves the token but no version. The state holds no paths, so find the
        // `python-*` folder by the identity pinned at uninstall; none means it is gone.
        RootId::RuntimePython => fs::read_dir(layout.runtime())
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("python-")))
            .find(|p| Root::open(p).is_ok_and(|r| r.identity() == pinned))
            .unwrap_or_else(|| layout.runtime().join("python-")),
        RootId::RuntimeDownloads => layout.runtime().join("downloads"),
        RootId::Bootstrap => layout.bootstrap(),
        RootId::Updater => layout.updater(),
        RootId::AppData => layout.app_data(),
        RootId::InstanceProd => layout.instances().join("prod"),
        RootId::PreRepair => layout.pre_repair_venv(),
    }
}

/// Re-prove, from disk, that the root is still FlowPad's — the state file proves nothing.
fn still_owned(layout: &Layout, root: RootId, path: &Path) -> Result<(), String> {
    match root {
        RootId::Venv => {
            let record = fs::read_to_string(layout.ownership_record())
                .ok()
                .and_then(|t| super::classify::OwnershipRecord::parse(&t))
                .ok_or("no ownership record")?;
            use sha2::Digest;
            let receipt = fs::read(path.join(ops::RECEIPT_FILE)).map_err(|_| "its receipt is gone")?;
            if record.receipt_sha256.as_deref() != Some(state::hex(&sha2::Sha256::digest(&receipt)).as_str()) {
                return Err("its receipt no longer matches the ownership record".into());
            }
            Ok(())
        }
        RootId::RuntimePython | RootId::RuntimeDownloads => {
            let token = ops::read_json(&layout.runtime_state())
                .and_then(|v| v.pointer("/runtimeOwnership/token").and_then(|t| t.as_str()).map(String::from))
                .ok_or("no runtime ownership record")?;
            let sentinel = ops::read_json(&path.join(ops::RUNTIME_SENTINEL))
                .and_then(|v| v.get("token").and_then(|t| t.as_str()).map(String::from))
                .ok_or("its ownership marker is gone")?;
            if sentinel == token {
                Ok(())
            } else {
                Err("its ownership marker does not match".into())
            }
        }
        RootId::PreRepair => {
            if ops::pre_repair_proven(layout) {
                Ok(())
            } else {
                Err("its set-aside record no longer proves the desktop made it".into())
            }
        }
        RootId::InstanceProd => {
            if path.join(ops::DESKTOP_MARKER).exists() && !path.join(ops::CLI_STAMP).exists() {
                Ok(())
            } else {
                Err("it is no longer a desktop-only instance".into())
            }
        }
        // Fixed FlowPad-only locations whose identity was pinned at uninstall.
        RootId::Bootstrap | RootId::Updater | RootId::AppData => Ok(()),
    }
}

/// Run the pending cleanup. Returns the process exit code (0 when nothing is left pending).
pub fn run(layout: &Layout, trigger: Trigger, log: &mut Log) -> i32 {
    status(layout, &format!("executed (trigger {trigger:?})"));
    log.line(&format!("deferred cleanup started (trigger {trigger:?})"));
    if trigger == Trigger::Logon && win::key_exists(HKCU, ops::UNINSTALL_KEY) {
        status(layout, "aborted: FlowPad Desktop is installed again; the installer finishes the cleanup");
        return 0;
    }
    let dir = layout.helper_dir();
    let Ok(text) = fs::read_to_string(dir.join(STATE_FILE)) else {
        status(layout, "nothing pending");
        return 0;
    };
    let secret = credential().ok().and_then(|c| c.get_password().ok()).and_then(|s| Secret::decode(&s));
    let body = match state::verify(&text, secret.as_ref(), win::now()) {
        Ok(b) => b,
        Err(e) => {
            status(layout, &format!("refused: {e}; nothing deleted"));
            log.line(&format!("deferred cleanup refused: {e}"));
            return 20;
        }
    };

    let gathered = ops::gather(layout, log);
    let engine_owned = body.entries.iter().any(|e| e.root == RootId::Venv);
    super::run::stop_processes(layout, &gathered, engine_owned, &mut Ledger::default(), log);

    let mut ledger = Ledger::default();
    let mut remaining = Vec::new();
    let mut kept_on_purpose = Vec::new();
    for entry in &body.entries {
        let pinned = super::Identity { volume: entry.volume, file_id: entry.file_id };
        let path = root_path(layout, entry.root, pinned);
        match Root::open(&path) {
            Err(super::delete::Refused::Missing) => {
                status(layout, &format!("{:?}: already gone", entry.root));
                if entry.root == RootId::InstanceProd {
                    // The user chose to delete prod; its keys go even when the folder went some other way.
                    ops::remove_instance_credentials("prod", log);
                }
                continue;
            }
            Err(e) => {
                status(layout, &format!("{:?}: skipped, the folder {e}", entry.root));
                continue;
            }
            Ok(r) if r.identity() != pinned => {
                status(layout, &format!("{:?}: skipped, {} is a different folder now", entry.root, path.display()));
                continue;
            }
            Ok(_) => {}
        }
        if ops::waits_for_venv(entry.root) && layout.venv().exists() {
            status(layout, &format!("{:?}: waits, the engine is still there", entry.root));
            continue;
        }
        if ops::waits_for_venv(entry.root) {
            let pending_aside = body.entries.iter().any(|e| e.root == RootId::PreRepair);
            let users = ops::set_aside_copies_on_runtime(layout);
            if users.iter().any(|n| !(pending_aside && n == "flowpad.pre-repair")) {
                // A set-aside engine FlowPad keeps on purpose runs on it: kept, not "still in use".
                let msg = format!("{:?}: kept, a set-aside engine runs on it ({})", entry.root, users.join(", "));
                status(layout, &msg);
                log.line(&msg);
                kept_on_purpose.push(entry.root);
                continue;
            }
            if !users.is_empty() {
                status(layout, &format!("{:?}: waits, the set-aside engine is still there", entry.root));
                continue;
            }
        }
        if let Err(why) = still_owned(layout, entry.root, &path) {
            status(layout, &format!("{:?}: skipped, {why}", entry.root));
            continue;
        }
        let evidence = match entry.root {
            RootId::Venv | RootId::PreRepair => Some(ops::RECEIPT_FILE),
            RootId::RuntimePython | RootId::RuntimeDownloads => Some(ops::RUNTIME_SENTINEL),
            RootId::InstanceProd => Some(ops::DESKTOP_MARKER),
            _ => None,
        };
        if let Some(l) = ops::remove_tree(&mut ledger, log, &format!("{:?}", entry.root), &path, Some(entry.root), evidence) {
            remaining.push(l);
        } else if entry.root == RootId::InstanceProd && !path.exists() {
            // As in the uninstaller: the instance's keys go with its folder.
            ops::remove_instance_credentials("prod", log);
        }
    }

    // Verified: each pinned root is gone (or is no longer the pinned object).
    let still_there: Vec<String> = body
        .entries
        .iter()
        .filter(|e| !kept_on_purpose.contains(&e.root))
        .filter(|e| {
            let pinned = super::Identity { volume: e.volume, file_id: e.file_id };
            Root::open(&root_path(layout, e.root, pinned)).is_ok_and(|r| r.identity() == pinned)
        })
        .map(|e| format!("{:?}", e.root))
        .collect();
    if still_there.is_empty() {
        status(layout, "verified: every pending item is gone");
        if body.entries.iter().any(|e| e.root == RootId::PreRepair) && !layout.pre_repair_venv().exists() {
            ops::remove_file(&mut ledger, log, "set-aside engine record", &layout.aside_ownership_record());
        }
        if body.entries.iter().any(|e| e.root == RootId::Venv) && !layout.venv().exists() {
            ops::remove_file(&mut ledger, log, "engine ownership record", &layout.ownership_record());
        }
        if body.entries.iter().any(|e| ops::waits_for_venv(e.root)) {
            ops::remove_if_empty(&layout.runtime());
            if !layout.runtime().exists() {
                let _ = ops::remove_children(&mut ledger, log, "runtime record", &layout.flow_home(), &[ops::RUNTIME_STATE_FILE.to_string()]);
            }
        }
        if body.entries.iter().any(|e| e.root == RootId::InstanceProd) {
            // As in the uninstaller: `global/` and `~/.flow` go once no instance is left.
            ops::remove_flow_home_if_unused(layout, &mut ledger, log);
        }
        finish(layout);
        0
    } else {
        // No re-registration: the next installer or the manual command finishes the rest.
        status(layout, &format!("still in use: {}; left for the next FlowPad installer or the manual command", still_there.join(", ")));
        let _ = remaining;
        20
    }
}

/// Everything verified: delete the key (so this state can never be replayed), then have a
/// detached shell remove the helper's exact files once this process has exited.
fn finish(layout: &Layout) {
    if let Ok(c) = credential() {
        let _ = c.delete_credential();
    }
    win::delete_value(HKCU, RUN_ONCE_KEY, run_once_value());
    let dir = layout.helper_dir();
    let _ = fs::remove_file(dir.join(STATE_FILE));
    if let Ok(root) = Root::open(&dir) {
        // Only the helper's own files, by exact name; then the folders only if empty.
        let script = format!(
            "ping -n 3 127.0.0.1 >nul & del /f /q \"{d}\\{exe}\" \"{d}\\{status}\" & rmdir \"{d}\" 2>nul & rmdir \"{p}\" 2>nul",
            d = root.path().display(),
            exe = HELPER_EXE,
            status = STATUS_FILE,
            p = layout.local_flowpad().display()
        );
        drop(root);
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = std::process::Command::new("cmd.exe")
            .args(["/d", "/c"])
            .raw_arg(&script)
            .creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW)
            .spawn();
    }
}
