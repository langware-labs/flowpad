//! Gathering facts and removing owned things, on Windows (FLOWPAD-2250). Every target is opened
//! through the root gate ([`Root::open`]); anything inside FlowPad's folders that FlowPad did not
//! create is left alone and listed; evidence files go last; whatever is locked is returned as a
//! [`Leftover`], pinned by its root's file identity, for the deferred cleanup.

use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use super::classify::{
    EngineFacts, Facts, InstanceFacts, OwnershipRecord, RuntimeAction, RuntimeDecision, RuntimeDirFacts, RuntimeFacts,
};
use super::delete::{FailureKind, Report, Root};
use super::procs::{self, Context, InstanceServer, ServerInfo};
use super::receipt::{self, Receipt};
use super::report::{Ledger, Log};
use super::state::{hex, RootId};
use super::win::Layout;
use super::Identity;

pub const RECEIPT_FILE: &str = "uv-receipt.toml";
pub const RUNTIME_SENTINEL: &str = ".flowpad-owned";
pub const DESKTOP_MARKER: &str = ".desktop_managed";
pub const CLI_STAMP: &str = ".cli_used";
/// `~/.flow/desktop-runtime.json`: the runtime's ownership token and version.
pub const RUNTIME_STATE_FILE: &str = "desktop-runtime.json";
pub const PSF_SIGNER: &str = "Python Software Foundation";
pub const SNIFFER_MARK: &str = "--name=flowpad_sniffer";
/// The desktop's per-user uninstall key (uuid5 of appId `ai.flowpad.desktop`, electron-builder).
pub const UNINSTALL_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\01ea153f-315f-5cd5-8810-48807d21bb7d";

/// Something that could not be removed now, pinned so a later run acts on the same object only.
#[derive(Debug, Clone)]
pub struct Leftover {
    pub root: RootId,
    pub identity: Identity,
    pub path: PathBuf,
    pub detail: String,
}

/// Everything the decisions and the process selection need.
pub struct Gathered {
    pub facts: Facts,
    pub runtime: RuntimeFacts,
    pub receipt: Option<Receipt>,
    pub servers: Vec<InstanceServer>,
    pub engine_interpreters: Vec<String>,
}

fn is_real_dir(p: &Path) -> bool {
    fs::symlink_metadata(p).map(|m| m.is_dir() && !m.file_type().is_symlink()).unwrap_or(false)
}

pub fn read_json(p: &Path) -> Option<serde_json::Value> {
    fs::read_to_string(p).ok().and_then(|t| serde_json::from_str(super::classify::strip_bom(&t)).ok())
}

/// `home = …` of a venv's `pyvenv.cfg`.
fn venv_home(venv: &Path) -> Option<PathBuf> {
    let text = fs::read_to_string(venv.join("pyvenv.cfg")).ok()?;
    text.lines().find_map(|l| {
        let (k, v) = l.split_once('=')?;
        (k.trim().eq_ignore_ascii_case("home")).then(|| PathBuf::from(v.trim()))
    })
}

pub fn gather(layout: &Layout, log: &mut Log) -> Gathered {
    let venv = layout.venv();
    let venv_exists = is_real_dir(&venv) || fs::symlink_metadata(&venv).is_ok();
    let record = fs::read_to_string(layout.ownership_record()).ok().and_then(|t| OwnershipRecord::parse(&t));
    let identity = Root::open(&venv).ok().map(|r| {
        let id = r.identity();
        (id.volume.to_string(), id.file_id.to_string())
    });
    let receipt_bytes = fs::read(venv.join(RECEIPT_FILE)).ok();
    let receipt_sha256 = receipt_bytes.as_ref().map(|b| hex(&Sha256::digest(b)));
    let receipt = receipt_bytes.as_ref().map(|b| receipt::parse(&String::from_utf8_lossy(b)));

    let stamp_since = layout.flow_home().join("global").join("cli-stamp-since");
    let stamping_active = stamp_since.exists();
    // The instances that existed before CLI use was stamped; without the list, every instance may have been.
    let preexisting: Option<Vec<String>> = read_json(&stamp_since)
        .and_then(|v| v.get("preexisting").and_then(|a| a.as_array()).map(|a| a.iter().filter_map(|n| n.as_str().map(String::from)).collect()));
    let mut instances = Vec::new();
    let mut servers = Vec::new();
    if let Ok(rd) = fs::read_dir(layout.instances()) {
        for e in rd.flatten() {
            let p = e.path();
            if !fs::symlink_metadata(&p).map(|m| m.is_dir()).unwrap_or(false) {
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            let desktop_managed = p.join(DESKTOP_MARKER).exists();
            if desktop_managed {
                if let Some(info) = fs::read_to_string(p.join("server.json")).ok().and_then(|t| ServerInfo::parse(&t)) {
                    servers.push(InstanceServer { instance: name.clone(), info });
                }
            }
            let predates_stamping = preexisting.as_ref().is_none_or(|names| names.iter().any(|n| n == &name));
            instances.push(InstanceFacts { name, desktop_managed, cli_used: p.join(CLI_STAMP).exists(), predates_stamping });
        }
    }
    instances.sort_by(|a, b| a.name.cmp(&b.name));

    let mut engine_interpreters = vec![venv.join("Scripts").join("python.exe").display().to_string()];
    if let Some(home) = venv_home(&venv) {
        engine_interpreters.push(home.join("python.exe").display().to_string());
    }

    let ctx = Context {
        app_exe: layout.app_exe().display().to_string(),
        engine_interpreters: engine_interpreters.clone(),
        owned_venv: None,
        servers: servers.clone(),
        listeners: procs::tcp_listeners(),
    };
    let selection = procs::select(&procs::scan(), &ctx);
    for n in &selection.notes {
        log.line(&format!("processes: {n}"));
    }

    let facts = Facts {
        engine: EngineFacts { venv_exists, record, identity, receipt_sha256, receipt: receipt.clone() },
        instances,
        stamping_active,
        independent_server_running: !selection.independent_servers.is_empty(),
    };
    let runtime = gather_runtime(layout);
    Gathered { facts, runtime, receipt, servers, engine_interpreters }
}

fn gather_runtime(layout: &Layout) -> RuntimeFacts {
    let state = read_json(&layout.runtime_state());
    let state_token = state
        .as_ref()
        .and_then(|s| s.get("runtimeOwnership"))
        .and_then(|o| o.get("token"))
        .and_then(|t| t.as_str())
        .map(String::from);
    let state_version = state.as_ref().and_then(|s| s.get("version")).and_then(|v| v.as_str()).map(String::from);
    let runtime = layout.runtime();
    let mut dirs = Vec::new();
    if let Ok(rd) = fs::read_dir(&runtime) {
        for e in rd.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            let Ok(md) = fs::symlink_metadata(&p) else { continue };
            if md.file_type().is_symlink() {
                // Never read through it: a marker behind a link proves nothing.
                dirs.push(RuntimeDirFacts { name, link: true, ..Default::default() });
                continue;
            }
            if !md.is_dir() {
                continue;
            }
            let sentinel_token = read_json(&p.join(RUNTIME_SENTINEL))
                .and_then(|v| v.get("token").and_then(|t| t.as_str()).map(String::from));
            let legacy_candidate = sentinel_token.is_none() && state_version.as_deref().is_some_and(|v| name == format!("python-{v}"));
            let psf_signed_python = legacy_candidate.then(|| {
                crate::authenticode::verify(&p.join("python.exe"), "the interpreter").is_ok_and(|signer| signer == PSF_SIGNER)
            });
            let files = fs::read_dir(&p)
                .map(|rd| rd.flatten().map(|f| f.file_name().to_string_lossy().to_string()).collect())
                .unwrap_or_default();
            dirs.push(RuntimeDirFacts { name, sentinel_token, psf_signed_python, files, link: false });
        }
    }
    dirs.sort_by(|a, b| a.name.cmp(&b.name));
    let used_by_another_environment = fs::read_dir(layout.uv_tools())
        .map(|rd| {
            rd.flatten().any(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                // The live venv and the set-aside copies that go with the engine are not "another"
                // environment; a `.pre-repair` copy that stays (not proven ours) is.
                name != "flowpad"
                    && !name.starts_with("flowpad.corrupt-")
                    && !(name == "flowpad.pre-repair" && pre_repair_proven(layout))
                    && venv_home(&e.path()).is_some_and(|h| procs::under(&h.display().to_string(), &runtime.display().to_string()))
            })
        })
        .unwrap_or(false);
    RuntimeFacts { state_token, state_version, dirs, used_by_another_environment }
}

// ── removal ──────────────────────────────────────────────────────────────────────────────────

fn record_report(ledger: &mut Ledger, what: &str, path: &Path, report: &Report) -> bool {
    if let Some(moved) = &report.moved_to {
        ledger.left(what, path, &format!("it was moved to {} during the uninstall", moved.display()));
        return false;
    }
    if report.failures.is_empty() {
        return true;
    }
    false
}

fn describe(report: &Report) -> String {
    let locked = report.failures.iter().filter(|f| f.kind == FailureKind::Locked).count();
    let denied = report.failures.iter().filter(|f| f.kind == FailureKind::AccessDenied).count();
    let other = report.failures.len() - locked - denied;
    let mut parts = Vec::new();
    if locked > 0 {
        parts.push(format!("{locked} in use"));
    }
    if denied > 0 {
        parts.push(format!("{denied} denied by permissions"));
    }
    if other > 0 {
        parts.push(format!("{other} other error(s)"));
    }
    parts.join(", ")
}

/// Whether a failed report may be finished later: only items that were merely in use.
fn deferrable(report: &Report) -> bool {
    report.moved_to.is_none() && report.failures.iter().all(|f| f.kind == FailureKind::Locked)
}

/// Remove a whole owned directory: its contents (evidence last), then the directory itself.
/// Returns a leftover when only locked items stand in the way.
pub fn remove_tree(
    ledger: &mut Ledger,
    log: &mut Log,
    what: &str,
    path: &Path,
    root_id: Option<RootId>,
    evidence_last: Option<&str>,
) -> Option<Leftover> {
    let root = match Root::open(path) {
        Ok(r) => r,
        Err(super::delete::Refused::Missing) => return None,
        Err(e) => {
            ledger.left(what, path, &format!("not removed: it {e}"));
            return None;
        }
    };
    let identity = root.identity();
    let report = root.remove_contents(evidence_last);
    log.line(&format!("remove {what} {}: removed {} item(s), failures {:?}", path.display(), report.removed, report.failures.len()));
    if record_report(ledger, what, path, &report) {
        match root.remove_self() {
            Ok(()) => ledger.removed(what, path),
            Err(e) => ledger.left(what, path, &format!("emptied but the folder itself was not removed: {e}")),
        }
        return None;
    }
    if report.moved_to.is_some() {
        return None;
    }
    match (root_id, deferrable(&report)) {
        (Some(id), true) => Some(Leftover { root: id, identity, path: path.to_path_buf(), detail: describe(&report) }),
        _ => {
            ledger.left(what, path, &describe(&report));
            None
        }
    }
}

/// Remove named children of `parent` (files or trees). Unknown children are never touched.
pub fn remove_children(ledger: &mut Ledger, log: &mut Log, what: &str, parent: &Path, names: &[String]) -> bool {
    if names.is_empty() {
        return true;
    }
    let root = match Root::open(parent) {
        Ok(r) => r,
        Err(super::delete::Refused::Missing) => return true,
        Err(e) => {
            ledger.left(what, parent, &format!("not removed: it {e}"));
            return false;
        }
    };
    let mut all = true;
    for n in names {
        let report = root.remove_child(n);
        let p = parent.join(n);
        log.line(&format!("remove {what} {}: removed {}, failures {}", p.display(), report.removed, report.failures.len()));
        if report.complete() {
            if report.removed > 0 {
                ledger.removed(what, &p);
            }
        } else {
            all = false;
            ledger.left(what, &p, &describe(&report));
        }
    }
    all
}

/// Remove `dir` only if it is empty (never recursively).
pub fn remove_if_empty(dir: &Path) -> bool {
    match Root::open(dir) {
        Ok(r) => match r.list() {
            Ok(names) if names.is_empty() => r.remove_self().is_ok(),
            _ => false,
        },
        Err(_) => false,
    }
}

/// The `flowpad.pre-repair` venv is one the desktop made: the record set aside with it says
/// `desktop`, and the folder's identity and receipt are still the ones recorded.
pub fn pre_repair_proven(layout: &Layout) -> bool {
    let aside = layout.pre_repair_venv();
    let Some(record) = fs::read_to_string(layout.aside_ownership_record()).ok().and_then(|t| OwnershipRecord::parse(&t)) else {
        return false;
    };
    let Ok(root) = Root::open(&aside) else { return false };
    let id = root.identity();
    let receipt = fs::read(aside.join(RECEIPT_FILE)).ok().map(|b| hex(&Sha256::digest(&b)));
    record.origin == "desktop"
        && record.venv_volume.as_deref() == Some(id.volume.to_string().as_str())
        && record.venv_file_id.as_deref() == Some(id.file_id.to_string().as_str())
        && receipt.is_some()
        && record.receipt_sha256 == receipt
}

/// The engine venv, its shims and leftovers of the desktop's own quarantine and repair.
pub fn remove_engine(layout: &Layout, receipt: Option<&Receipt>, ledger: &mut Ledger, log: &mut Log) -> Vec<Leftover> {
    let mut leftovers = Vec::new();
    // Shims first, from the receipt read before anything was deleted. Only the two FlowPad entry
    // points, only at the exact path uv put them.
    if let Some(r) = receipt {
        let bin = layout.local_bin();
        let shims: Vec<String> = r
            .entrypoints
            .iter()
            .filter(|e| e.from == "flowpad" && (e.name == "flow" || e.name == "flow-sdk-mcp"))
            .filter(|e| procs::same_path_pub(&e.install_path, &bin.join(format!("{}.exe", e.name)).display().to_string()))
            .map(|e| format!("{}.exe", e.name))
            .collect();
        remove_children(ledger, log, "engine command", &bin, &shims);
    }
    if let Some(l) = remove_tree(ledger, log, "FlowPad engine", &layout.venv(), Some(RootId::Venv), Some(RECEIPT_FILE)) {
        leftovers.push(l);
    }
    let siblings: Vec<String> = fs::read_dir(layout.uv_tools())
        .map(|rd| {
            rd.flatten()
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|n| n.starts_with("flowpad.corrupt-"))
                .collect()
        })
        .unwrap_or_default();
    remove_children(ledger, log, "set-aside engine", &layout.uv_tools(), &siblings);
    // A repair renames the engine it replaces to `.pre-repair` and deletes it once the repair
    // holds. One still here was left by an interrupted repair: it goes only when the record set
    // aside with it proves the desktop made it (an engine the desktop adopted is set aside the same way).
    let aside = layout.pre_repair_venv();
    if pre_repair_proven(layout) {
        remove_tree(ledger, log, "engine set aside by a repair", &aside, None, Some(RECEIPT_FILE));
    } else if fs::symlink_metadata(&aside).is_ok() {
        ledger.kept(
            "engine set aside by an interrupted repair",
            &aside,
            "FlowPad cannot confirm it installed this copy; delete the folder if you do not need it",
        );
    }
    if fs::symlink_metadata(&aside).is_err() {
        remove_children(ledger, log, "set-aside engine record", &layout.local_flowpad(), &["engine-ownership.pre-repair.json".to_string()]);
    }
    if !layout.venv().exists() {
        remove_children(ledger, log, "engine ownership record", &layout.local_flowpad(), &["engine-ownership.json".to_string()]);
    }
    leftovers
}

pub fn remove_runtime(layout: &Layout, decisions: &[RuntimeDecision], ledger: &mut Ledger, log: &mut Log) -> Vec<Leftover> {
    let mut leftovers = Vec::new();
    let runtime = layout.runtime();
    for d in decisions {
        let p = runtime.join(&d.name);
        match &d.action {
            RuntimeAction::Keep(reason) => ledger.kept("Python runtime folder", &p, reason),
            RuntimeAction::RemoveDir => {
                let (id, evidence) = if d.name == "downloads" {
                    (RootId::RuntimeDownloads, Some(RUNTIME_SENTINEL))
                } else {
                    (RootId::RuntimePython, Some(RUNTIME_SENTINEL))
                };
                if let Some(l) = remove_tree(ledger, log, "Python runtime", &p, Some(id), evidence) {
                    leftovers.push(l);
                }
            }
            RuntimeAction::RemoveFiles(names) => {
                remove_children(ledger, log, "Python runtime download", &p, names);
                remove_if_empty(&p);
            }
        }
    }
    if decisions.iter().all(|d| !matches!(d.action, RuntimeAction::Keep(_))) && leftovers.is_empty() {
        remove_if_empty(&runtime);
        remove_children(ledger, log, "runtime record", &layout.flow_home(), &[RUNTIME_STATE_FILE.to_string()]);
    }
    leftovers
}

/// The engine is in use and waits for the deferred cleanup: its runtime must wait behind it (the
/// venv runs on it), so the runtime folders are pinned now and removed after the venv is gone.
pub fn defer_runtime(layout: &Layout, decisions: &[RuntimeDecision], ledger: &mut Ledger) -> Vec<Leftover> {
    let mut leftovers = Vec::new();
    let runtime = layout.runtime();
    for d in decisions {
        let p = runtime.join(&d.name);
        match &d.action {
            RuntimeAction::Keep(reason) => ledger.kept("Python runtime folder", &p, reason),
            RuntimeAction::RemoveDir => {
                let id = if d.name == "downloads" { RootId::RuntimeDownloads } else { RootId::RuntimePython };
                match Root::open(&p) {
                    Ok(r) => leftovers.push(Leftover {
                        root: id,
                        identity: r.identity(),
                        path: p,
                        detail: "waits for the engine, which is in use".into(),
                    }),
                    Err(super::delete::Refused::Missing) => {}
                    Err(e) => ledger.left("Python runtime", &p, &format!("not removed: it {e}")),
                }
            }
            RuntimeAction::RemoveFiles(_) => {
                ledger.left("Python runtime download", &p, "the engine that uses it is still in use; remove it after a restart")
            }
        }
    }
    leftovers
}

/// Runtime roots are removed only once no venv may still run on them.
pub fn waits_for_venv(root: RootId) -> bool {
    matches!(root, RootId::RuntimePython | RootId::RuntimeDownloads)
}

fn plain_installer_name(n: &str) -> bool {
    n.len() <= 140
        && !n.starts_with('.')
        && n.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        && (n.ends_with(".exe") || n.ends_with(".partial"))
}

/// The desktop's own state outside user data: install marker, launcher downloads, the updater's
/// cache, temp leftovers. Only names FlowPad writes; anything else is listed and left.
pub fn remove_app_state(layout: &Layout, own_log: Option<&Path>, ledger: &mut Ledger, log: &mut Log) {
    remove_children(ledger, log, "install marker", &layout.flow_home(), &["desktop-install-in-progress.json".to_string()]);

    let bootstrap = layout.bootstrap();
    if let Ok(rd) = fs::read_dir(&bootstrap) {
        let (ours, other): (Vec<String>, Vec<String>) = rd
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .partition(|n| n == "flowpad-install.log" || plain_installer_name(n));
        remove_children(ledger, log, "launcher download", &bootstrap, &ours);
        other.iter().for_each(|n| ledger.not_ours("file", &bootstrap.join(n)));
        remove_if_empty(&bootstrap);
    }

    let updater = layout.updater();
    let pending = updater.join("pending");
    if let Some(info) = read_json(&pending.join("update-info.json")) {
        let mut names = vec!["update-info.json".to_string()];
        if let Some(f) = info.get("fileName").and_then(|f| f.as_str()).filter(|f| plain_installer_name(f)) {
            names.push(f.to_string());
        }
        remove_children(ledger, log, "pending update", &pending, &names);
    }
    remove_if_empty(&pending);
    remove_children(ledger, log, "update installer", &updater, &["installer.exe".to_string()]);
    remove_if_empty(&updater);

    let temp = layout.temp.clone();
    let own = own_log.and_then(|p| p.file_name()).map(|n| n.to_string_lossy().to_string());
    let names: Vec<String> = fs::read_dir(&temp)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|n| {
                    Some(n) != own.as_ref()
                        && (n.starts_with("flowpad-uv-")
                            || n.starts_with("flowpad-compat-")
                            || n == "flowpad-bootstrap"
                            || (n.starts_with("flowpad-support-") && n.ends_with(".zip")))
                })
                .collect()
        })
        .unwrap_or_default();
    remove_children(ledger, log, "temporary file", &temp, &names);
}

/// Opt-in: the desktop's own settings, cache and desktop logs.
pub fn remove_app_data(layout: &Layout, ledger: &mut Ledger, log: &mut Log) -> Vec<Leftover> {
    let mut leftovers = Vec::new();
    if let Some(l) = remove_tree(ledger, log, "FlowPad Desktop settings and cache", &layout.app_data(), Some(RootId::AppData), None) {
        leftovers.push(l);
    }
    let logs = layout.flow_home().join("logs").join("main_desktop");
    remove_tree(ledger, log, "desktop logs", &logs, None, None);
    let desktop_files: Vec<String> = fs::read_dir(layout.flow_home())
        .map(|rd| {
            rd.flatten()
                .map(|e| e.file_name().to_string_lossy().to_string())
                // desktop-runtime.json proves the runtime is ours: it goes with the runtime (run.rs).
                .filter(|n| n.starts_with("desktop-") && n.ends_with(".json") && n != RUNTIME_STATE_FILE)
                .collect()
        })
        .unwrap_or_default();
    remove_children(ledger, log, "desktop state", &layout.flow_home(), &desktop_files);
    leftovers
}

/// Opt-in: one desktop-managed instance's data, its `.desktop_managed` marker last, and its key.
pub fn remove_instance(layout: &Layout, name: &str, ledger: &mut Ledger, log: &mut Log) -> Vec<Leftover> {
    let dir = layout.instances().join(name);
    let id = (name == "prod").then_some(RootId::InstanceProd);
    let leftover = remove_tree(ledger, log, &format!("FlowPad data ({name})"), &dir, id, Some(DESKTOP_MARKER));
    if !dir.exists() {
        remove_instance_credentials(name, log);
    }
    leftover.into_iter().collect()
}

/// Where FlowPad keeps an instance's key: the name every writer uses (pinned by a test below).
pub const RELEASE_INSTANCE_KEY_SERVICE: &str = "Flowpad.ai.sod_key";
/// Debug builds (the end-to-end tests, whose folders are a scratch tree) use their own name, so a
/// test run never deletes the real key of the machine's prod.
pub const INSTANCE_KEY_SERVICE: &str = if cfg!(debug_assertions) { "Flowpad.ai.sod_key.debug" } else { RELEASE_INSTANCE_KEY_SERVICE };

/// An instance's stored keys go once its folder is gone (now, or in the deferred cleanup).
pub fn remove_instance_credentials(name: &str, log: &mut Log) {
    for account in [format!("{name}.flow-rs"), name.to_string()] {
        if let Ok(entry) = keyring::Entry::new(INSTANCE_KEY_SERVICE, &account) {
            if entry.delete_credential().is_ok() {
                log.line(&format!("removed stored credential {INSTANCE_KEY_SERVICE}/{account}"));
            }
        }
    }
}

/// `global/` and `~/.flow` itself go only when no instance is left: they are shared by all.
pub fn remove_flow_home_if_unused(layout: &Layout, ledger: &mut Ledger, log: &mut Log) {
    let instances = layout.instances();
    let none_left = fs::read_dir(&instances).map(|mut rd| rd.next().is_none()).unwrap_or(true);
    if !none_left {
        return;
    }
    remove_if_empty(&instances);
    remove_tree(ledger, log, "shared FlowPad state", &layout.flow_home().join("global"), None, None);
    let logs = layout.flow_home().join("logs");
    remove_if_empty(&logs);
    if !remove_if_empty(&layout.flow_home()) {
        if let Ok(rd) = fs::read_dir(layout.flow_home()) {
            rd.flatten().for_each(|e| ledger.not_ours("item", &e.path()));
        }
    }
}

/// Are FlowPad's Claude Code hooks gone from the user's settings? (`flow uninstall` removes them.)
pub fn sniffer_hooks_remain(layout: &Layout) -> bool {
    let p = layout.profile.join(".claude").join("settings.json");
    match fs::read_to_string(p) {
        Ok(text) => text.contains(SNIFFER_MARK),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The uninstaller deletes the keys the engine and the desktop wrote: same service name.
    #[test]
    fn the_release_key_service_is_the_one_the_writers_use() {
        let python = include_str!("../../../instance_settings/base_settings.py");
        let desktop = include_str!("../../../../electron/uv-manager.js");
        assert!(python.contains(&format!("SOD_KEY_KEYCHAIN_SERVICE = \"{RELEASE_INSTANCE_KEY_SERVICE}\"")));
        assert!(desktop.contains(&format!("SOD_KEY_KEYCHAIN_SERVICE = '{RELEASE_INSTANCE_KEY_SERVICE}'")));
        assert_ne!(INSTANCE_KEY_SERVICE, RELEASE_INSTANCE_KEY_SERVICE, "a test build must not touch the real keys");
    }
}
