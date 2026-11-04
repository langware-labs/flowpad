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

/// `deferred-cleanup` exit code when the pending state had expired: dropped, nothing deleted (0 is
/// "nothing left pending", 20 "still pending, tried again by the next trigger").
pub const EXIT_EXPIRED: i32 = 30;

/// Who started the cleanup.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    /// RunOnce at sign-in.
    Logon,
    /// A new FlowPad installer, before the app's first launch, where FlowPad was not installed.
    Installer,
    /// A FlowPad installer run over an installed FlowPad (an update, or Setup run again): the
    /// pending folders may be in use by that install now.
    Reinstall,
    /// The user, by the documented command.
    Manual,
}

fn root_path(layout: &Layout, root: RootId, pinned: super::Identity) -> PathBuf {
    match root {
        RootId::Venv => layout.venv(),
        // Not rebuilt from desktop-runtime.json's `version`: a repair that failed after marking its
        // folder leaves the token but no version. The state holds no paths, so find the
        // `python-*` folder by the identity pinned at uninstall; none means it is gone.
        RootId::RuntimePython => find_pinned(&layout.runtime(), "python-", pinned),
        RootId::RuntimeDownloads => layout.runtime().join("downloads"),
        RootId::Bootstrap => layout.bootstrap(),
        RootId::Updater => layout.updater(),
        RootId::AppData => layout.app_data(),
        RootId::InstanceProd => layout.instances().join("prod"),
        RootId::PreRepair => layout.pre_repair_venv(),
        // Several may exist (`flowpad.corrupt-<time>`): the one pinned at uninstall, by identity.
        RootId::CorruptCopy => find_pinned(&layout.uv_tools(), "flowpad.corrupt-", pinned),
    }
}

/// The `<prefix>*` folder in `parent` with the pinned identity. None matching: a folder that could
/// not be opened (in use, a scan) may be it, so that one is returned and the entry waits; only
/// when every candidate opened and none matched is it gone (a path that does not exist).
fn find_pinned(parent: &Path, prefix: &str, pinned: super::Identity) -> PathBuf {
    let mut unopened = None;
    let candidates = fs::read_dir(parent)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.file_name().is_some_and(|n| n.to_string_lossy().starts_with(prefix)));
    for p in candidates {
        match Root::open(&p) {
            Ok(r) if r.identity() == pinned => return p,
            Ok(_) | Err(super::delete::Refused::Missing) => {}
            Err(e) if refused_for_good(&e) => {}
            Err(_) => unopened = unopened.or(Some(p)),
        }
    }
    unopened.unwrap_or_else(|| parent.join(prefix))
}

/// The root will never be deleted as it is: a junction or symlink (at it or above it), or a file
/// where the folder was. A folder that cannot be opened right now — in use, delete-pending, denied
/// during a scan, or denied for good by its ACL: nothing tells these apart reliably — stays
/// pending and is tried again by the next trigger, until the state expires (state.rs); an expired
/// state is dropped and reported (see `run`).
fn refused_for_good(e: &super::delete::Refused) -> bool {
    use super::delete::Refused::*;
    match e {
        ReparsePoint | Redirected { .. } | NotADirectory => true,
        Busy(_) | Unreadable(_) | Missing => false,
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
        // Repaired before sentinels: proven by the recorded folder name and a PSF-signed interpreter.
        RootId::RuntimePython if ops::legacy_runtime_proven(layout, path) => Ok(()),
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
        // Fixed FlowPad-only locations (and a quarantined copy of the engine FlowPad removed),
        // whose identity was pinned at uninstall.
        RootId::Bootstrap | RootId::Updater | RootId::AppData | RootId::CorruptCopy => Ok(()),
    }
}

/// Run the pending cleanup. Returns the process exit code (0 when nothing is left pending).
pub fn run(layout: &Layout, trigger: Trigger, log: &mut Log) -> i32 {
    status(layout, &format!("executed (trigger {trigger:?})"));
    log.line(&format!("deferred cleanup started (trigger {trigger:?})"));
    let dir = layout.helper_dir();
    let Ok(text) = fs::read_to_string(dir.join(STATE_FILE)) else {
        status(layout, "nothing pending");
        return 0;
    };
    // FlowPad is installed again: the pending folders — the engine, its runtime, prod — may be the
    // new install's now, with the same identity and the same proofs. The pending cleanup ends
    // here, nothing deleted. (The installer of a fresh install gets one try first, below.)
    let installed = match trigger {
        Trigger::Reinstall => true,
        Trigger::Installer => false,
        Trigger::Logon | Trigger::Manual => win::key_exists(HKCU, ops::uninstall_key()),
    };
    if installed {
        drop_pending(layout, &text, "FlowPad Desktop is installed again", log);
        return 0;
    }
    let secret = credential().ok().and_then(|c| c.get_password().ok()).and_then(|s| Secret::decode(&s));
    let body = match state::verify(&text, secret.as_ref(), win::now()) {
        Ok(b) => b,
        Err(state::Rejected::Expired) => {
            // The ceiling on retries: past its lifetime the state can never authorize anything.
            drop_pending(layout, &text, "expired", log);
            return EXIT_EXPIRED;
        }
        Err(e) => {
            status(layout, &format!("refused: {e}; nothing deleted"));
            log.line(&format!("deferred cleanup refused: {e}"));
            return 20;
        }
    };

    let gathered = ops::gather(layout, log);
    let pinned_of = |e: &state::Entry| super::Identity { volume: e.volume, file_id: e.file_id };
    // First, before anything is stopped or deleted: which engine environments (the venv, its
    // set-aside copies) this run will remove — still the pinned folder, still provably FlowPad's.
    // Only their processes are stopped, and the runtime decisions below never depend on the order
    // the state lists its entries in.
    let removable: Vec<(usize, PathBuf)> = body
        .entries
        .iter()
        .enumerate()
        .filter(|(_, e)| ops::is_engine_root(e.root))
        .filter_map(|(i, e)| {
            let path = root_path(layout, e.root, pinned_of(e));
            let same = Root::open(&path).is_ok_and(|r| r.identity() == pinned_of(e));
            (same && still_owned(layout, e.root, &path).is_ok()).then_some((i, path))
        })
        .collect();
    let venv_goes = removable.iter().any(|(i, _)| body.entries[*i].root == RootId::Venv);
    // The venv is KEPT for good (and its runtime with it) only when it is provably not to be
    // removed: another folder now, a link, or no longer FlowPad's. One that cannot be opened right
    // now (in use, a scan) is still pending: its runtime waits behind it.
    let venv_kept = body.entries.iter().any(|e| {
        e.root == RootId::Venv && {
            let path = root_path(layout, e.root, pinned_of(e));
            match Root::open(&path) {
                Ok(r) => r.identity() != pinned_of(e) || still_owned(layout, e.root, &path).is_err(),
                Err(err) => refused_for_good(&err),
            }
        }
    });
    let owned: Vec<PathBuf> = removable.iter().map(|(_, p)| p.clone()).collect();
    super::run::stop_processes(layout, &gathered, venv_goes, &owned, &mut Ledger::default(), log);

    let mut ledger = Ledger::default();
    let mut remaining = Vec::new();
    // Entries (by index) this run leaves on purpose: no longer provably FlowPad's, another folder
    // now, or a runtime a kept engine copy runs on. Never deleted, and not pending either.
    let mut kept: Vec<usize> = Vec::new();
    // Engine environments first, then everything else (the runtime waits behind them).
    let mut order: Vec<usize> = (0..body.entries.len()).collect();
    order.sort_by_key(|&i| !ops::is_engine_root(body.entries[i].root));
    for idx in order {
        let entry = &body.entries[idx];
        let pinned = pinned_of(entry);
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
            Err(e) if refused_for_good(&e) => {
                status(layout, &format!("{:?}: kept, the folder {e}", entry.root));
                kept.push(idx);
                continue;
            }
            Err(e) => {
                // Cannot be opened now (in use, delete-pending, a scan, an ACL): still pending.
                status(layout, &format!("{:?}: waits, the folder {e}", entry.root));
                continue;
            }
            Ok(r) if r.identity() != pinned => {
                status(layout, &format!("{:?}: kept, {} is a different folder now", entry.root, path.display()));
                kept.push(idx);
                continue;
            }
            Ok(_) => {}
        }
        if ops::waits_for_venv(entry.root) && layout.venv().exists() {
            // The runtime waits only behind an engine this cleanup is removing (and could not yet).
            // An engine it keeps (no longer proven, another folder now), or one it never had to
            // remove, stays for good, and so does its runtime.
            let venv_pending = !venv_kept && body.entries.iter().any(|e| e.root == RootId::Venv);
            if venv_pending {
                status(layout, &format!("{:?}: waits, the engine is still there", entry.root));
            } else {
                let msg = format!("{:?}: kept, the engine it runs is kept", entry.root);
                status(layout, &msg);
                log.line(&msg);
                kept.push(idx);
            }
            continue;
        }
        if ops::waits_for_venv(entry.root) {
            // Engine copies this run tried and that are still in use: the runtime waits behind
            // them. Any other copy on the runtime is one FlowPad keeps, and so it keeps the runtime.
            let waiting: Vec<String> = removable
                .iter()
                .filter(|(i, p)| ops::is_set_aside_root(body.entries[*i].root) && p.exists())
                .filter_map(|(_, p)| p.file_name().map(|n| n.to_string_lossy().to_string()))
                .collect();
            let users = ops::set_aside_copies_on_runtime(layout);
            if users.iter().any(|n| !waiting.contains(n)) {
                let msg = format!("{:?}: kept, a set-aside engine runs on it ({})", entry.root, users.join(", "));
                status(layout, &msg);
                log.line(&msg);
                kept.push(idx);
                continue;
            }
            if !users.is_empty() {
                status(layout, &format!("{:?}: waits, a set-aside engine is still in use", entry.root));
                continue;
            }
        }
        if let Err(why) = still_owned(layout, entry.root, &path) {
            status(layout, &format!("{:?}: kept, {why}", entry.root));
            kept.push(idx);
            continue;
        }
        let evidence = match entry.root {
            RootId::Venv | RootId::PreRepair => Some(ops::RECEIPT_FILE),
            RootId::RuntimePython | RootId::RuntimeDownloads => Some(ops::runtime_evidence(&path)),
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

    // Verified: each pinned root is gone (or is no longer the pinned object), unless kept on purpose.
    let still_there: Vec<String> = body
        .entries
        .iter()
        .enumerate()
        .filter(|(i, _)| !kept.contains(i))
        .filter(|(_, e)| match Root::open(&root_path(layout, e.root, pinned_of(e))) {
            Ok(r) => r.identity() == pinned_of(e),
            Err(super::delete::Refused::Missing) => false,
            // Not verifiably gone: an unreadable root stays pending, and is tried again.
            Err(e) => !refused_for_good(&e),
        })
        .map(|(_, e)| format!("{:?}", e.root))
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
    } else if trigger == Trigger::Installer {
        // The app this installer just put in place launches next and may take these folders over:
        // nothing may be deleted under it later.
        drop_pending(layout, &text, &format!("still in use: {}; FlowPad is being installed again", still_there.join(", ")), log);
        let _ = remaining;
        20
    } else {
        // No re-registration: the next installer or the manual command finishes the rest.
        status(layout, &format!("still in use: {}; left for the next FlowPad installer or the manual command", still_there.join(", ")));
        let _ = remaining;
        20
    }
}

/// End the pending cleanup without deleting anything: its key, state and helper go, and what it
/// still listed is reported (the state is read only to name it — it proves nothing).
fn drop_pending(layout: &Layout, text: &str, why: &str, log: &mut Log) {
    let left: Vec<String> = serde_json::from_str::<state::Signed>(text)
        .map(|s| s.body.entries)
        .unwrap_or_default()
        .iter()
        .map(|e| root_path(layout, e.root, super::Identity { volume: e.volume, file_id: e.file_id }))
        .filter(|p| p.exists())
        .map(|p| p.display().to_string())
        .collect();
    let msg = if left.is_empty() {
        format!("{why}: the pending cleanup is dropped; nothing it listed is left")
    } else {
        format!("{why}: the pending cleanup is dropped, nothing deleted; still on disk, remove by hand if not needed: {}", left.join("; "))
    };
    status(layout, &msg);
    log.line(&msg);
    finish(layout);
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
