//! `flow-rs uninstall`: classify, stop, remove, schedule, report (FLOWPAD-2250).

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use super::classify::{decide_engine, decide_instance, decide_runtime, DataOffer, EngineDecision, InstanceDecision};
use super::deferred;
use super::ops::{self, Gathered, Leftover};
use super::procs::{self, Context, Role};
use super::report::{self, Ledger, Log, Outcome};
use super::win::{self, Layout};

#[derive(Debug, Clone, Default)]
pub struct Options {
    pub install_dir: PathBuf,
    pub classify_only: bool,
    /// The user's consent to remove an engine that is only offered (checkbox / `/REMOVEENGINE`).
    pub remove_engine: bool,
    pub delete_app_data: bool,
    pub delete_instance_data: bool,
    pub log: Option<PathBuf>,
    pub result: Option<PathBuf>,
    /// classify-only: an INI file the NSIS page reads.
    pub ini: Option<PathBuf>,
}

const GRACEFUL_STOP: Duration = Duration::from_secs(10);
const HOOKS_REMOVAL: Duration = Duration::from_secs(30);
const RETRIES: usize = 3;
const RETRY_PAUSE: Duration = Duration::from_millis(1500);

/// Stop what the desktop launched. A graceful `flow stop` for each desktop instance whose server
/// is verified; then, only when the engine goes, force-stop the verified set and re-check. A
/// kept engine's processes are never force-stopped.
pub fn stop_processes(layout: &Layout, g: &Gathered, engine_goes: bool, ledger: &mut Ledger, log: &mut Log) -> bool {
    let ctx = |owned: bool| Context {
        app_exe: layout.app_exe().display().to_string(),
        engine_interpreters: g.engine_interpreters.clone(),
        owned_venv: owned.then(|| layout.venv().display().to_string()),
        servers: g.servers.clone(),
        listeners: procs::tcp_listeners(),
    };
    let flow = layout.venv().join("Scripts").join("flow.exe");
    let first = procs::select(&procs::scan(), &ctx(engine_goes));
    for s in &g.servers {
        let verified = s.info.server_pid.is_some_and(|pid| first.verified.iter().any(|v| v.pid == pid && v.role == Role::Server));
        if verified && flow.exists() {
            let env = [("FLOWPAD_DESKTOP", "1"), ("FLOW_INSTANCE", s.instance.as_str())];
            match win::run_bounded(&flow, &["stop"], &env, GRACEFUL_STOP) {
                Ok(r) => log.line(&format!("flow stop ({}): exit {:?}{}", s.instance, r.code, if r.timed_out { ", timed out" } else { "" })),
                Err(e) => log.line(&format!("flow stop ({}) could not run: {e}", s.instance)),
            }
        }
    }
    let force_roles = |r: Role| engine_goes || r == Role::App;
    for pass in 0..RETRIES {
        let snapshot = procs::scan();
        let sel = procs::select(&snapshot, &ctx(engine_goes));
        let targets: Vec<_> = sel.verified.iter().filter(|v| force_roles(v.role)).collect();
        if targets.is_empty() {
            for o in &sel.orphans {
                ledger.processes_left.push(format!("pid {o} (started by FlowPad, not a FlowPad process)"));
            }
            return true;
        }
        for v in targets {
            let created = snapshot.iter().find(|p| p.pid == v.pid).and_then(|p| p.created);
            match procs::terminate(v.pid, created) {
                Ok(()) => log.line(&format!("stopped pid {} ({:?}, {})", v.pid, v.role, v.image)),
                Err(e) => log.line(&format!("could not stop pid {} ({:?}): {e}", v.pid, v.role)),
            }
        }
        log.line(&format!("process pass {} done", pass + 1));
        std::thread::sleep(RETRY_PAUSE);
    }
    let sel = procs::select(&procs::scan(), &ctx(engine_goes));
    let survivors: Vec<_> = sel.verified.iter().filter(|v| force_roles(v.role)).collect();
    for v in &survivors {
        ledger.processes_left.push(format!("pid {} ({:?}) could not be stopped", v.pid, v.role));
    }
    survivors.is_empty()
}

fn ini_escape(s: &str) -> String {
    s.replace(['\r', '\n'], " ")
}

/// The page's sizes are only for display, and the page has to appear inside the classify
/// deadline: one budget for ALL the folders on the page, in entries and in time. Past it, a
/// folder's size is what was counted, shown as "more than".
const SIZE_WALK_ENTRIES: usize = 200_000;
const SIZE_WALK_TIME: Duration = Duration::from_secs(15);

struct SizeBudget {
    entries_left: usize,
    until: Instant,
}

impl SizeBudget {
    fn new(entries: usize, time: Duration) -> Self {
        SizeBudget { entries_left: entries, until: Instant::now() + time }
    }
    fn spent(&self) -> bool {
        self.entries_left == 0 || Instant::now() >= self.until
    }
}

/// A folder's size in MB, as the page shows it.
fn size_text(path: &Path, budget: &mut SizeBudget) -> String {
    fn walk(p: &Path, budget: &mut SizeBudget, cut: &mut bool) -> u64 {
        if budget.spent() {
            *cut = true;
            return 0;
        }
        budget.entries_left -= 1;
        let Ok(md) = fs::symlink_metadata(p) else { return 0 };
        if md.file_type().is_symlink() {
            return 0;
        }
        if md.is_dir() {
            fs::read_dir(p).map(|rd| rd.flatten().map(|e| walk(&e.path(), budget, cut)).sum()).unwrap_or(0)
        } else {
            md.len()
        }
    }
    let mut cut = false;
    let bytes = walk(path, budget, &mut cut);
    let mb = format!("{:.1} MB", bytes as f64 / 1_048_576.0);
    if cut {
        format!("more than {mb}")
    } else {
        mb
    }
}

/// The page the NSIS uninstaller shows comes from here: what will happen to the engine, and
/// exactly which data each checkbox would delete.
fn write_ini(path: &Path, layout: &Layout, engine: &EngineDecision, instances: &[InstanceDecision]) -> std::io::Result<()> {
    let mut s = String::new();
    s.push_str("[engine]\n");
    s.push_str(&format!("category={}\n", serde_json::to_value(engine.category).unwrap().as_str().unwrap_or("")));
    s.push_str(&format!("remove={}\n", engine.remove_by_default as u8));
    s.push_str(&format!("offer={}\n", engine.opt_in_offered as u8));
    s.push_str(&format!("reason={}\n", ini_escape(&engine.reasons.join("; "))));
    let mut budget = SizeBudget::new(SIZE_WALK_ENTRIES, SIZE_WALK_TIME);
    let app = layout.app_data();
    s.push_str("[appdata]\n");
    s.push_str(&format!(
        "text={}\n",
        ini_escape(&format!(
            "{} ({}), {}",
            app.display(),
            size_text(&app, &mut budget),
            layout.flow_home().join("logs").join("main_desktop").display()
        ))
    ));
    s.push_str("[instances]\n");
    let mut offered = Vec::new();
    let mut warn = false;
    let mut kept = Vec::new();
    for i in instances {
        let dir = layout.instances().join(&i.name);
        match &i.offer {
            DataOffer::Offered => offered.push(format!("{} ({})", dir.display(), size_text(&dir, &mut budget))),
            DataOffer::OfferedWithWarning => {
                warn = true;
                offered.push(format!("{} ({})", dir.display(), size_text(&dir, &mut budget)))
            }
            DataOffer::NotOffered(r) => kept.push(format!("{} — kept: {r}", i.name)),
        }
    }
    s.push_str(&format!("offer={}\n", (!offered.is_empty()) as u8));
    s.push_str(&format!("warn={}\n", warn as u8));
    s.push_str(&format!("text={}\n", ini_escape(&offered.join(", "))));
    s.push_str(&format!("kept={}\n", ini_escape(&kept.join("; "))));
    // NSIS reads INI files as the system code page; keep it to UTF-16 LE with a BOM, which it handles.
    let mut bytes = vec![0xFF, 0xFE];
    for u in s.encode_utf16() {
        bytes.extend_from_slice(&u.to_le_bytes());
    }
    fs::write(path, bytes)
}

pub fn run(o: &Options) -> i32 {
    let mut log = Log::open(o.log.as_deref());
    let layout = match Layout::resolve(&o.install_dir) {
        Ok(l) => l,
        Err(e) => {
            log.line(&format!("cannot resolve the user's folders: {e}; nothing removed"));
            return Outcome::Partial.exit_code();
        }
    };
    log.line(&format!("flow-rs uninstall: {o:?}"));
    let g = ops::gather(&layout, &mut log);
    let engine = decide_engine(&g.facts);
    let instances: Vec<InstanceDecision> = g.facts.instances.iter().map(|i| decide_instance(i, g.facts.stamping_active)).collect();
    log.line(&format!("engine: {engine:?}"));
    log.line(&format!("instances: {instances:?}"));

    if o.classify_only {
        if let Some(ini) = &o.ini {
            if let Err(e) = write_ini(ini, &layout, &engine, &instances) {
                log.line(&format!("cannot write {}: {e}", ini.display()));
                return Outcome::Partial.exit_code();
            }
        }
        return 0;
    }

    let mut ledger = Ledger::default();
    let mut engine_goes = engine.removed(o.remove_engine);
    // FlowPad's Claude Code hooks call the engine's `flow`: remove them first, and keep the
    // engine if they cannot be confirmed gone (Claude Code must not be left calling a missing flow).
    if engine_goes {
        let flow = layout.venv().join("Scripts").join("flow.exe");
        if flow.exists() {
            match win::run_bounded(&flow, &["uninstall"], &[("FLOWPAD_DESKTOP", "1")], HOOKS_REMOVAL) {
                Ok(r) => log.line(&format!("flow uninstall (hooks): exit {:?}", r.code)),
                Err(e) => log.line(&format!("flow uninstall (hooks) could not run: {e}")),
            }
        }
        if ops::sniffer_hooks_remain(&layout) {
            engine_goes = false;
            ledger.kept(
                "FlowPad engine",
                &layout.venv(),
                "FlowPad's Claude Code hooks could not be removed; run `flow uninstall`, then remove the engine with `uv tool uninstall flowpad`",
            );
        }
    }
    if !engine_goes && engine.category != super::classify::EngineCategory::Absent && ledger.kept.is_empty() {
        let hint = if engine.opt_in_offered {
            "kept as you chose; remove it later with `uv tool uninstall flowpad`".to_string()
        } else {
            format!("{}; remove it with `uv tool uninstall flowpad` if nothing else needs it", engine.reasons.join("; "))
        };
        ledger.kept("FlowPad engine", &layout.venv(), &hint);
    }

    stop_processes(&layout, &g, engine_goes, &mut ledger, &mut log);

    let engine_absent = !g.facts.engine.venv_exists;
    let selected_instances: Vec<String> = if o.delete_instance_data {
        instances
            .iter()
            .filter(|i| matches!(i.offer, DataOffer::Offered | DataOffer::OfferedWithWarning))
            .map(|i| i.name.clone())
            .collect()
    } else {
        Vec::new()
    };

    let mut leftovers = remove_all(&layout, &g, engine_goes, engine_absent, o, &selected_instances, &mut ledger, &mut log);

    // Retry what was only in use: stop verified processes again, wait, try again.
    for attempt in 1..=RETRIES {
        if leftovers.is_empty() {
            break;
        }
        log.line(&format!("retry {attempt}: {} item(s) in use", leftovers.len()));
        std::thread::sleep(RETRY_PAUSE);
        stop_processes(&layout, &g, engine_goes, &mut Ledger::default(), &mut log);
        let mut again: Vec<Leftover> = Vec::new();
        for l in leftovers {
            if ops::waits_for_venv(l.root) && again.iter().any(|a| a.root == super::state::RootId::Venv) {
                again.push(l);
                continue;
            }
            let evidence = evidence_for(l.root);
            if let Some(l2) = ops::remove_tree(&mut ledger, &mut log, &format!("{:?}", l.root), &l.path, Some(l.root), evidence) {
                again.push(l2);
            }
        }
        leftovers = again;
    }
    if engine_goes && !layout.venv().exists() {
        ops::remove_children(&mut ledger, &mut log, "engine ownership record", &layout.local_flowpad(), &["engine-ownership.json".to_string()]);
        if !leftovers.iter().any(|l| ops::waits_for_venv(l.root)) && !layout.runtime().exists() {
            ops::remove_children(&mut ledger, &mut log, "runtime record", &layout.flow_home(), &[ops::RUNTIME_STATE_FILE.to_string()]);
        }
    }
    deferred::schedule(&layout, leftovers, &mut ledger, &mut log);
    ops::remove_if_empty(&layout.local_flowpad());

    let outcome = ledger.outcome();
    log.line(&format!("outcome: {outcome:?}"));
    if let Some(result) = &o.result {
        let detail = serde_json::json!({ "engine": engine, "instances": instances });
        if let Err(e) = report::write_result(result, outcome, &ledger, detail) {
            log.line(&format!("cannot write the result: {e}"));
        }
    }
    outcome.exit_code()
}

fn evidence_for(root: super::state::RootId) -> Option<&'static str> {
    use super::state::RootId::*;
    match root {
        Venv => Some(ops::RECEIPT_FILE),
        RuntimePython | RuntimeDownloads => Some(ops::RUNTIME_SENTINEL),
        InstanceProd => Some(ops::DESKTOP_MARKER),
        Bootstrap | Updater | AppData => None,
    }
}

#[allow(clippy::too_many_arguments)]
fn remove_all(
    layout: &Layout,
    g: &Gathered,
    engine_goes: bool,
    engine_absent: bool,
    o: &Options,
    instances: &[String],
    ledger: &mut Ledger,
    log: &mut Log,
) -> Vec<Leftover> {
    let mut leftovers = Vec::new();
    if engine_goes {
        leftovers.extend(ops::remove_engine(layout, g.receipt.as_ref(), ledger, log));
    }
    let venv_pending = leftovers.iter().any(|l| l.root == super::state::RootId::Venv);
    let runtime = decide_runtime(&g.runtime, (engine_goes && (venv_pending || !layout.venv().exists())) || engine_absent);
    if venv_pending {
        leftovers.extend(ops::defer_runtime(layout, &runtime, ledger));
    } else {
        leftovers.extend(ops::remove_runtime(layout, &runtime, ledger, log));
    }
    ops::remove_app_state(layout, o.log.as_deref(), ledger, log);
    if o.delete_app_data {
        leftovers.extend(ops::remove_app_data(layout, ledger, log));
    }
    for name in instances {
        leftovers.extend(ops::remove_instance(layout, name, ledger, log));
    }
    if !instances.is_empty() {
        ops::remove_flow_home_if_unused(layout, ledger, log);
    }
    leftovers
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_size_budget_is_shared_by_every_folder_on_the_page() {
        let dir = std::env::temp_dir().join(format!("flowrs-size-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        for f in ["a", "b"] {
            fs::create_dir_all(dir.join(f)).unwrap();
            for i in 0..5 {
                fs::write(dir.join(f).join(format!("f{i}")), vec![0u8; 1024]).unwrap();
            }
        }
        let mut roomy = SizeBudget::new(100, Duration::from_secs(60));
        assert_eq!(size_text(&dir.join("a"), &mut roomy), "0.0 MB");
        // 8 entries: the first folder (6) fits, the second runs out.
        let mut tight = SizeBudget::new(8, Duration::from_secs(60));
        assert!(!size_text(&dir.join("a"), &mut tight).starts_with("more than "));
        assert!(size_text(&dir.join("b"), &mut tight).starts_with("more than "));
        let mut timed_out = SizeBudget::new(100, Duration::ZERO);
        assert!(size_text(&dir.join("a"), &mut timed_out).starts_with("more than "));
        fs::remove_dir_all(&dir).unwrap();
    }
}
