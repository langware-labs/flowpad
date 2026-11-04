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
    /// Remove only the app's own state: the engine, its runtime and set-aside copies stay whatever
    /// they are. The uninstaller passes it when its page could not classify them, and so told the
    /// user they are kept.
    pub app_only: bool,
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
/// `owned`: the engine environments being removed (the venv, its set-aside copies) — whatever
/// runs from them is stopped. `engine_goes`: the venv itself goes, so every verified FlowPad
/// process may be force-stopped.
pub fn stop_processes(layout: &Layout, g: &Gathered, engine_goes: bool, owned: &[PathBuf], ledger: &mut Ledger, log: &mut Log) -> bool {
    let mut owned_venvs = Vec::new();
    let mut engine_interpreters = g.engine_interpreters.clone();
    for venv in owned {
        // A venv being removed: its own base interpreter counts as the engine's (never an
        // unproven copy's, whose `home` may be the user's Python).
        if let Some(home) = ops::venv_home(venv) {
            let base = home.join("python.exe").display().to_string();
            if !engine_interpreters.contains(&base) {
                engine_interpreters.push(base);
            }
        }
        owned_venvs.push(venv.display().to_string());
    }
    let ctx = || Context {
        app_exe: layout.app_exe().display().to_string(),
        engine_interpreters: engine_interpreters.clone(),
        owned_venvs: owned_venvs.clone(),
        servers: g.servers.clone(),
        listeners: procs::tcp_listeners(),
    };
    let flow = layout.venv().join("Scripts").join("flow.exe");
    let first = procs::select(&procs::scan(), &ctx());
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
    // Force-stop: everything verified when the engine goes; otherwise the app, and whatever runs
    // from a set-aside copy being removed (its launcher, interpreter, server, workers).
    let force = |sel: &procs::Selection, v: &procs::Verified| engine_goes || v.role == Role::App || sel.from_owned_venv.contains(&v.pid);
    for pass in 0..RETRIES {
        let snapshot = procs::scan();
        let sel = procs::select(&snapshot, &ctx());
        let targets: Vec<_> = sel.verified.iter().filter(|v| force(&sel, v)).collect();
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
    let sel = procs::select(&procs::scan(), &ctx());
    let survivors: Vec<_> = sel.verified.iter().filter(|v| force(&sel, v)).collect();
    for v in &survivors {
        ledger.processes_left.push(format!("pid {} ({:?}) could not be stopped", v.pid, v.role));
    }
    survivors.is_empty()
}

fn ini_escape(s: &str) -> String {
    s.replace(['\r', '\n'], " ")
}

/// The page's sizes are only for display, and the page has to appear inside the classify
/// deadline: one budget for ALL the folders on the page, in entries and in time. Each folder in
/// turn may use everything left except a guaranteed minimum held back for each folder after it,
/// so a large folder is measured whole wherever it comes, and no folder is left unmeasured. Past
/// its allowance, a folder's size is what was counted, shown as "more than".
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

/// The page's budget, handed out folder by folder.
struct PageBudget {
    entries_left: usize,
    until: Instant,
    folders_left: usize,
    /// Held back for each folder not measured yet: a quarter of an equal share.
    min_entries: usize,
    min_time: Duration,
}

impl PageBudget {
    fn new(entries: usize, time: Duration, folders: usize) -> Self {
        let n = folders.max(1);
        PageBudget {
            entries_left: entries,
            until: Instant::now() + time,
            folders_left: n,
            min_entries: entries / n / 4,
            min_time: time / n as u32 / 4,
        }
    }
    /// Measure the next folder with what is left, less the minimum kept for the ones after it.
    fn size_text(&mut self, path: &Path) -> String {
        let later = self.folders_left.saturating_sub(1);
        let time_left = self.until.saturating_duration_since(Instant::now());
        let entries = self.entries_left.saturating_sub(self.min_entries * later);
        let time = time_left.saturating_sub(self.min_time * later as u32);
        let mut share = SizeBudget::new(entries, time);
        let allotted = share.entries_left;
        let text = size_text(path, &mut share);
        self.entries_left -= allotted - share.entries_left;
        self.folders_left = later;
        text
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
    if budget.spent() {
        return "size not measured".into();
    }
    let mut cut = false;
    let bytes = walk(path, budget, &mut cut);
    let mb = format!("{:.1} MB", bytes as f64 / 1_048_576.0);
    if !cut {
        mb
    } else if mb == "0.0 MB" {
        // "more than 0.0 MB" would read as empty.
        "size not measured".into()
    } else {
        format!("more than {mb}")
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
    // The user's data first (the instances: what they decide on), then the app data; each may use
    // what is left less the minimum held back for the ones after it (PageBudget), so a large
    // instance is measured whole and the app data still gets its share.
    let measured = instances.iter().filter(|i| !matches!(i.offer, DataOffer::NotOffered(_))).count() + 1;
    let mut budget = PageBudget::new(SIZE_WALK_ENTRIES, SIZE_WALK_TIME, measured);
    let app = layout.app_data();
    let mut offered = Vec::new();
    let mut warn = false;
    let mut kept = Vec::new();
    for i in instances {
        let dir = layout.instances().join(&i.name);
        match &i.offer {
            DataOffer::Offered => offered.push(format!("{} ({})", dir.display(), budget.size_text(&dir))),
            DataOffer::OfferedWithWarning => {
                warn = true;
                offered.push(format!("{} ({})", dir.display(), budget.size_text(&dir)))
            }
            DataOffer::NotOffered(r) => kept.push(format!("{} — kept: {r}", i.name)),
        }
    }
    let app_size = budget.size_text(&app);
    s.push_str("[appdata]\n");
    s.push_str(&format!(
        "text={}\n",
        ini_escape(&format!("{} ({}), {}", app.display(), app_size, layout.flow_home().join("logs").join("main_desktop").display()))
    ));
    s.push_str("[instances]\n");
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
    let mut engine_goes = engine.removed(o.remove_engine) && !o.app_only;
    if o.app_only && engine.category != super::classify::EngineCategory::Absent {
        ledger.kept("FlowPad engine", &layout.venv(), "kept: FlowPad could not check it when the uninstall began");
    }
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

    // What this run removes: the venv and its quarantined copies when the engine goes, and a proven
    // set-aside copy when the engine goes or is already gone.
    let mut owned: Vec<PathBuf> = Vec::new();
    if engine_goes {
        owned.push(layout.venv());
        owned.extend(ops::corrupt_copies(&layout).into_iter().map(|n| layout.uv_tools().join(n)));
    }
    // No engine left to run on the runtime (the user was told only the app goes when `app_only`).
    let engine_absent = !g.facts.engine.venv_exists && !o.app_only;
    if (engine_goes || engine_absent) && g.pre_repair_proven {
        owned.push(layout.pre_repair_venv());
    }
    stop_processes(&layout, &g, engine_goes, &owned, &mut ledger, &mut log);

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
        stop_processes(&layout, &g, engine_goes, &owned, &mut Ledger::default(), &mut log);
        let mut again: Vec<Leftover> = Vec::new();
        for l in leftovers {
            if ops::waits_for_venv(l.root) && again.iter().any(|a| ops::is_engine_root(a.root)) {
                again.push(l);
                continue;
            }
            let evidence = evidence_for(l.root, &l.path);
            if let Some(l2) = ops::remove_tree(&mut ledger, &mut log, &format!("{:?}", l.root), &l.path, Some(l.root), evidence) {
                again.push(l2);
            }
        }
        leftovers = again;
    }
    if engine_goes && !layout.venv().exists() {
        ops::remove_file(&mut ledger, &mut log, "engine ownership record", &layout.ownership_record());
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

fn evidence_for(root: super::state::RootId, path: &Path) -> Option<&'static str> {
    use super::state::RootId::*;
    match root {
        Venv | PreRepair => Some(ops::RECEIPT_FILE),
        RuntimePython | RuntimeDownloads => Some(ops::runtime_evidence(path)),
        InstanceProd => Some(ops::DESKTOP_MARKER),
        Bootstrap | Updater | AppData | CorruptCopy => None,
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
        leftovers.extend(ops::remove_engine(layout, g.receipt.as_ref(), g.pre_repair_proven, ledger, log));
    } else if engine_absent {
        // No engine, but an interrupted repair may have left the previous one set aside.
        leftovers.extend(ops::remove_pre_repair(layout, g.pre_repair_proven, ledger, log));
    }
    // The runtime waits behind an engine environment that is pending (in use): the venv or its set-aside copy.
    let venv_pending = leftovers.iter().any(|l| ops::is_engine_root(l.root));
    // A set-aside copy still here that is NOT pending (kept, or the engine stays) runs on the
    // runtime for good: removing the runtime would break it.
    let pending: Vec<String> = leftovers
        .iter()
        .filter(|l| ops::is_set_aside_root(l.root))
        .filter_map(|l| l.path.file_name().map(|n| n.to_string_lossy().to_string()))
        .collect();
    let mut runtime_facts = g.runtime.clone();
    runtime_facts.used_by_another_environment |= ops::set_aside_copies_on_runtime(layout).iter().any(|n| !pending.contains(n));
    let runtime = decide_runtime(&runtime_facts, (engine_goes && (venv_pending || !layout.venv().exists())) || engine_absent);
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

    fn folders(dir: &Path, sizes: &[(&str, usize)]) {
        for (name, files) in sizes {
            fs::create_dir_all(dir.join(name)).unwrap();
            for i in 0..*files {
                fs::write(dir.join(name).join(format!("f{i}")), vec![0u8; 300 * 1024]).unwrap();
            }
        }
    }

    #[test]
    fn a_large_folder_is_measured_whole_wherever_it_comes() {
        let dir = std::env::temp_dir().join(format!("flowrs-share-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        folders(&dir, &[("big", 29), ("small", 1)]);
        // 40 entries, 2 folders: 5 held back for the second. "big" (30 entries) comes FIRST and
        // is measured whole; "small" (2) still fits in what is left.
        let mut page = PageBudget::new(40, Duration::from_secs(60), 2);
        assert_eq!(page.size_text(&dir.join("big")), "8.5 MB");
        assert_eq!(page.size_text(&dir.join("small")), "0.3 MB");
        // Small first: what it leaves goes to the large one.
        let mut page = PageBudget::new(40, Duration::from_secs(60), 2);
        assert_eq!(page.size_text(&dir.join("small")), "0.3 MB");
        assert_eq!(page.size_text(&dir.join("big")), "8.5 MB");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_large_instance_then_a_large_app_data_are_both_measured_as_far_as_the_page_allows() {
        let dir = std::env::temp_dir().join(format!("flowrs-order-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        folders(&dir, &[("instance", 29), ("appdata", 4)]);
        // 40 entries for 2 folders: the instance (30) is measured whole; the app data (5) fits in
        // the 10 left — its minimum (5) was held back for it.
        let mut page = PageBudget::new(40, Duration::from_secs(60), 2);
        assert_eq!(page.size_text(&dir.join("instance")), "8.5 MB");
        assert_eq!(page.size_text(&dir.join("appdata")), "1.2 MB");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_folder_after_a_huge_one_still_gets_its_minimum() {
        let dir = std::env::temp_dir().join(format!("flowrs-min-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        folders(&dir, &[("huge", 60), ("small", 1)]);
        let mut page = PageBudget::new(40, Duration::from_secs(60), 2);
        assert!(page.size_text(&dir.join("huge")).starts_with("more than "));
        assert_eq!(page.size_text(&dir.join("small")), "0.3 MB", "its minimum (5 entries) was held back");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_spent_budget_says_more_than_or_not_measured() {
        let dir = std::env::temp_dir().join(format!("flowrs-size-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        for f in ["a", "b"] {
            fs::create_dir_all(dir.join(f)).unwrap();
            for i in 0..5 {
                fs::write(dir.join(f).join(format!("f{i}")), vec![0u8; 300 * 1024]).unwrap();
            }
        }
        let mut roomy = SizeBudget::new(100, Duration::from_secs(60));
        assert_eq!(size_text(&dir.join("a"), &mut roomy), "1.5 MB");
        // 8 entries: the first folder (6) fits, the second runs out.
        let mut tight = SizeBudget::new(8, Duration::from_secs(60));
        assert_eq!(size_text(&dir.join("a"), &mut tight), "1.5 MB");
        assert_eq!(size_text(&dir.join("b"), &mut tight), "more than 0.3 MB");
        assert_eq!(size_text(&dir.join("b"), &mut tight), "size not measured", "nothing counted: never \"0.0 MB\"");
        let mut timed_out = SizeBudget::new(100, Duration::ZERO);
        assert_eq!(size_text(&dir.join("a"), &mut timed_out), "size not measured");
        fs::remove_dir_all(&dir).unwrap();
    }
}
