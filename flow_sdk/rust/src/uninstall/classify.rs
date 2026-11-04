//! What may be removed (FLOWPAD-2250): pure decisions over facts gathered from the machine.
//!
//! An ownership record is evidence of ORIGIN, never of exclusive use. Removal needs positive
//! evidence that FlowPad Desktop made the thing AND the absence of every sign that something else
//! uses it; anything uncertain is kept and reported. The rules are the approved plan's §1 and §4.

use serde::{Deserialize, Serialize};

use super::receipt::Receipt;

/// `%LOCALAPPDATA%\Flowpad\engine-ownership.json`, written by the desktop
/// (`electron/engine-ownership.js`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnershipRecord {
    pub schema: u32,
    pub origin: String,
    pub venv: String,
    pub venv_volume: Option<String>,
    pub venv_file_id: Option<String>,
    pub receipt_sha256: Option<String>,
}

pub const RECORD_SCHEMA: u32 = 1;

/// A file saved by an editor (Notepad) may start with a UTF-8 byte-order mark; it changes nothing
/// about what the file says.
pub fn strip_bom(text: &str) -> &str {
    text.strip_prefix('\u{feff}').unwrap_or(text)
}

impl OwnershipRecord {
    /// None for anything but a well-formed record of the schema this uninstaller understands.
    pub fn parse(text: &str) -> Option<OwnershipRecord> {
        serde_json::from_str::<OwnershipRecord>(strip_bom(text)).ok().filter(|r| r.schema == RECORD_SCHEMA)
    }
}

#[derive(Debug, Clone, Default)]
pub struct EngineFacts {
    pub venv_exists: bool,
    pub record: Option<OwnershipRecord>,
    /// The venv directory's (volume serial, file id), as decimal strings.
    pub identity: Option<(String, String)>,
    pub receipt_sha256: Option<String>,
    pub receipt: Option<Receipt>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstanceFacts {
    pub name: String,
    /// `.desktop_managed` — the desktop managed it at some point (not proof of exclusive use).
    pub desktop_managed: bool,
    /// `.cli_used` — a `flow` the desktop did not run used it.
    pub cli_used: bool,
    /// It existed before CLI use was stamped (`cli-stamp-since` `preexisting`): an older engine may
    /// have driven it from the command line without a trace, so a missing `.cli_used` proves nothing.
    pub predates_stamping: bool,
}

#[derive(Debug, Clone, Default)]
pub struct Facts {
    pub engine: EngineFacts,
    pub instances: Vec<InstanceFacts>,
    /// `global/cli-stamp-since` exists: a missing `.cli_used` means "not used", not "unknown".
    pub stamping_active: bool,
    /// A FlowPad server is running that the desktop did not launch.
    pub independent_server_running: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EngineCategory {
    /// No engine venv.
    Absent,
    /// Made by the desktop and nothing else uses it: removed.
    DesktopExclusive,
    /// Made by the desktop, also used from the command line: kept unless the user opts in.
    DesktopOriginCliUsed,
    /// Installed before ownership records existed, inferred to be the desktop's: kept unless the user opts in.
    LegacyInferred,
    /// The engine does not stamp CLI use yet, so other use cannot be ruled out: kept unless the user opts in.
    StampingUnknown,
    /// The desktop installed over an engine it found: kept.
    Adopted,
    /// No ownership record: kept.
    Independent,
    /// Something else uses or changed it: kept.
    Shared,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineDecision {
    pub category: EngineCategory,
    pub remove_by_default: bool,
    pub opt_in_offered: bool,
    /// Why it is kept or why removing it needs consent — shown to the user and logged.
    pub reasons: Vec<String>,
}

impl EngineDecision {
    /// Whether the engine goes, given the user's opt-in (checkbox or `/REMOVEENGINE`).
    pub fn removed(&self, opted_in: bool) -> bool {
        self.remove_by_default || (self.opt_in_offered && opted_in)
    }
}

fn keep(category: EngineCategory, reasons: Vec<String>) -> EngineDecision {
    EngineDecision { category, remove_by_default: false, opt_in_offered: false, reasons }
}

fn offer(category: EngineCategory, reasons: Vec<String>) -> EngineDecision {
    EngineDecision { category, remove_by_default: false, opt_in_offered: true, reasons }
}

pub fn decide_engine(f: &Facts) -> EngineDecision {
    use EngineCategory::*;
    let e = &f.engine;
    if !e.venv_exists {
        return keep(Absent, vec![]);
    }
    let Some(record) = &e.record else {
        return keep(Independent, vec!["FlowPad Desktop did not install this engine".into()]);
    };
    match record.origin.as_str() {
        "adopted" => return keep(Adopted, vec!["the engine was installed before FlowPad Desktop used it".into()]),
        "desktop" | "legacy-inferred" => {}
        _ => return keep(Independent, vec!["the ownership record is not recognised".into()]),
    }

    let mut shared = Vec::new();
    let recorded = (record.venv_volume.clone(), record.venv_file_id.clone());
    let same_dir = matches!((&recorded, &e.identity), ((Some(v), Some(i)), Some((cv, ci))) if v == cv && i == ci);
    let same_receipt = matches!((&record.receipt_sha256, &e.receipt_sha256), (Some(a), Some(b)) if a == b);
    if !same_dir || !same_receipt {
        shared.push("the engine was changed after FlowPad Desktop installed it".into());
    }
    if !e.receipt.as_ref().is_some_and(Receipt::is_plain_flowpad) {
        shared.push("packages were added to the engine".into());
    }
    let others: Vec<&str> = f.instances.iter().filter(|i| !i.desktop_managed).map(|i| i.name.as_str()).collect();
    if !others.is_empty() {
        shared.push(format!("FlowPad instances not managed by the desktop use it: {}", others.join(", ")));
    }
    if f.independent_server_running {
        shared.push("a FlowPad server not started by the desktop is running".into());
    }
    if !shared.is_empty() {
        return keep(Shared, shared);
    }

    let cli: Vec<&str> = f.instances.iter().filter(|i| i.cli_used).map(|i| i.name.as_str()).collect();
    if record.origin == "legacy-inferred" {
        return offer(LegacyInferred, vec!["FlowPad cannot confirm nothing else uses this engine".into()]);
    }
    // Recorded use is the concrete reason; "unknown" only when nothing was recorded.
    if !cli.is_empty() {
        return offer(DesktopOriginCliUsed, vec![format!("the flow command line also uses it ({})", cli.join(", "))]);
    }
    if !f.stamping_active || f.instances.iter().any(|i| i.predates_stamping) {
        return offer(StampingUnknown, vec!["FlowPad cannot confirm nothing else uses this engine".into()]);
    }
    EngineDecision { category: DesktopExclusive, remove_by_default: true, opt_in_offered: false, reasons: vec![] }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case", tag = "offer", content = "reason")]
pub enum DataOffer {
    Offered,
    /// Offered, but the user must be told it may also be used from the command line.
    OfferedWithWarning,
    NotOffered(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceDecision {
    pub name: String,
    pub offer: DataOffer,
}

/// Whether an instance's data may be offered for deletion (plan §4). Never offered for an instance
/// the desktop did not manage, or one the command line also uses.
pub fn decide_instance(i: &InstanceFacts, stamping_active: bool) -> InstanceDecision {
    let offer = if !i.desktop_managed {
        DataOffer::NotOffered("not managed by FlowPad Desktop".into())
    } else if i.cli_used {
        DataOffer::NotOffered("also used by the flow command line".into())
    } else if !stamping_active || i.predates_stamping {
        DataOffer::OfferedWithWarning
    } else {
        DataOffer::Offered
    };
    InstanceDecision { name: i.name.clone(), offer }
}

// ── the repaired runtime ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RuntimeDirFacts {
    /// A directory directly in `%LOCALAPPDATA%\Flowpad\runtime`.
    pub name: String,
    /// The token in its `.flowpad-owned` sentinel, if any.
    pub sentinel_token: Option<String>,
    /// For a `python-<ver>` directory: whether its `python.exe` is signed by the Python Software Foundation.
    pub psf_signed_python: Option<bool>,
    /// The file names directly inside it (used for the legacy `downloads` folder).
    pub files: Vec<String>,
    /// A junction or symbolic link: never followed, so nothing behind it is read or proven.
    pub link: bool,
}

#[derive(Debug, Clone, Default)]
pub struct RuntimeFacts {
    /// `desktop-runtime.json` `runtimeOwnership.token`.
    pub state_token: Option<String>,
    /// `desktop-runtime.json` `version` (e.g. "3.11.9").
    pub state_version: Option<String>,
    pub dirs: Vec<RuntimeDirFacts>,
    /// Some uv tool environment's `pyvenv.cfg` `home` points into the runtime.
    pub used_by_another_environment: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case", tag = "action", content = "detail")]
pub enum RuntimeAction {
    RemoveDir,
    /// Remove only these files from the directory (a legacy `downloads` folder without a sentinel).
    RemoveFiles(Vec<String>),
    Keep(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RuntimeDecision {
    pub name: String,
    #[serde(flatten)]
    pub action: RuntimeAction,
}

/// Runtime directories go only when the engine that may run on them goes (or there is none), no
/// other environment uses them, and they are proven FlowPad's: the sentinel token matches the
/// desktop's record, or — for a runtime repaired before sentinels — the exact recorded
/// `python-<version>` folder holds a PSF-signed interpreter.
pub fn decide_runtime(r: &RuntimeFacts, engine_goes: bool) -> Vec<RuntimeDecision> {
    let legacy_python = r.state_version.as_ref().map(|v| format!("python-{v}"));
    let legacy_downloads = r
        .state_version
        .as_ref()
        .map(|v| [format!("python.{v}.nupkg.zip"), format!("python.{v}.nupkg.zip.partial")]);
    r.dirs
        .iter()
        .map(|d| {
            let action = if d.link {
                RuntimeAction::Keep("it is a junction or symbolic link; it was not followed".into())
            } else if !engine_goes {
                RuntimeAction::Keep("the engine that runs on it is kept".into())
            } else if r.used_by_another_environment {
                RuntimeAction::Keep("another Python environment uses it".into())
            } else if matches!((&d.sentinel_token, &r.state_token), (Some(t), Some(s)) if t == s) {
                RuntimeAction::RemoveDir
            } else if d.sentinel_token.is_some() {
                RuntimeAction::Keep("its ownership marker does not match FlowPad's record".into())
            } else if legacy_python.as_deref() == Some(d.name.as_str()) && d.psf_signed_python == Some(true) {
                RuntimeAction::RemoveDir
            } else if d.name == "downloads" {
                let names: Vec<String> = d
                    .files
                    .iter()
                    .filter(|f| legacy_downloads.as_ref().is_some_and(|l| l.iter().any(|n| n.eq_ignore_ascii_case(f))))
                    .cloned()
                    .collect();
                if names.is_empty() {
                    RuntimeAction::Keep("not proven to be FlowPad's".into())
                } else {
                    RuntimeAction::RemoveFiles(names)
                }
            } else {
                RuntimeAction::Keep("not proven to be FlowPad's".into())
            };
            RuntimeDecision { name: d.name.clone(), action }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::uninstall::receipt;

    const RECEIPT: &str = "[tool]\nrequirements = [{ name = \"flowpad\", specifier = \"==0.2.240\" }]\n";

    fn record(origin: &str) -> OwnershipRecord {
        OwnershipRecord {
            schema: 1,
            origin: origin.into(),
            venv: r"C:\Users\u\AppData\Roaming\uv\tools\flowpad".into(),
            venv_volume: Some("7".into()),
            venv_file_id: Some("100".into()),
            receipt_sha256: Some("aaa".into()),
        }
    }

    fn prod() -> InstanceFacts {
        InstanceFacts { name: "prod".into(), desktop_managed: true, cli_used: false, predates_stamping: false }
    }

    /// The desktop-exclusive baseline every test perturbs.
    fn facts() -> Facts {
        Facts {
            engine: EngineFacts {
                venv_exists: true,
                record: Some(record("desktop")),
                identity: Some(("7".into(), "100".into())),
                receipt_sha256: Some("aaa".into()),
                receipt: Some(receipt::parse(RECEIPT)),
            },
            instances: vec![prod()],
            stamping_active: true,
            independent_server_running: false,
        }
    }

    #[test]
    fn the_baseline_is_desktop_exclusive_and_removed() {
        let d = decide_engine(&facts());
        assert_eq!(d.category, EngineCategory::DesktopExclusive);
        assert!(d.removed(false));
    }

    #[test]
    fn no_venv_is_absent() {
        let mut f = facts();
        f.engine.venv_exists = false;
        assert_eq!(decide_engine(&f).category, EngineCategory::Absent);
        assert!(!decide_engine(&f).removed(true));
    }

    #[test]
    fn no_record_is_independent_and_never_offered() {
        let mut f = facts();
        f.engine.record = None;
        let d = decide_engine(&f);
        assert_eq!(d.category, EngineCategory::Independent);
        assert!(!d.opt_in_offered && !d.removed(true));
    }

    #[test]
    fn adopted_is_kept_even_with_consent() {
        let mut f = facts();
        f.engine.record = Some(record("adopted"));
        let d = decide_engine(&f);
        assert_eq!(d.category, EngineCategory::Adopted);
        assert!(!d.removed(true));
    }

    #[test]
    fn an_unknown_origin_is_not_trusted() {
        let mut f = facts();
        f.engine.record = Some(record("mine-honest"));
        assert_eq!(decide_engine(&f).category, EngineCategory::Independent);
    }

    #[test]
    fn every_sharing_signal_keeps_the_engine_and_is_named() {
        let cases: Vec<(&str, Box<dyn Fn(&mut Facts)>)> = vec![
            ("changed", Box::new(|f| f.engine.identity = Some(("7".into(), "999".into())))),
            ("changed", Box::new(|f| f.engine.identity = Some(("8".into(), "100".into())))),
            ("changed", Box::new(|f| f.engine.receipt_sha256 = Some("bbb".into()))),
            ("changed", Box::new(|f| f.engine.receipt_sha256 = None)),
            ("changed", Box::new(|f| f.engine.identity = None)),
            ("packages", Box::new(|f| {
                f.engine.receipt = Some(receipt::parse(&RECEIPT.replace("\" }]", "\" }, { name = \"rich\" }]")))
            })),
            ("packages", Box::new(|f| f.engine.receipt = None)),
            ("not managed", Box::new(|f| f.instances.push(InstanceFacts { name: "oss".into(), desktop_managed: false, cli_used: false, predates_stamping: false }))),
            ("server", Box::new(|f| f.independent_server_running = true)),
        ];
        for (needle, perturb) in cases {
            let mut f = facts();
            perturb(&mut f);
            let d = decide_engine(&f);
            assert_eq!(d.category, EngineCategory::Shared, "{needle}");
            assert!(!d.removed(true), "a shared engine is never removed, even with consent ({needle})");
            assert!(d.reasons.iter().any(|r| r.contains(needle)), "{needle}: {:?}", d.reasons);
        }
    }

    #[test]
    fn cli_use_needs_consent() {
        let mut f = facts();
        f.instances[0].cli_used = true;
        let d = decide_engine(&f);
        assert_eq!(d.category, EngineCategory::DesktopOriginCliUsed);
        assert!(!d.removed(false) && d.removed(true));
        assert!(d.reasons[0].contains("prod"));
    }

    #[test]
    fn legacy_and_unknown_stamping_need_consent() {
        let mut f = facts();
        f.engine.record = Some(record("legacy-inferred"));
        let d = decide_engine(&f);
        assert_eq!(d.category, EngineCategory::LegacyInferred);
        assert!(!d.removed(false) && d.removed(true));

        let mut f = facts();
        f.stamping_active = false;
        let d = decide_engine(&f);
        assert_eq!(d.category, EngineCategory::StampingUnknown);
        assert!(!d.removed(false) && d.removed(true));

        // Recorded CLI use is reported as such, even when the instance also predates the stamping.
        let mut f = facts();
        f.instances = vec![InstanceFacts { predates_stamping: true, cli_used: true, ..prod() }];
        let d = decide_engine(&f);
        assert_eq!(d.category, EngineCategory::DesktopOriginCliUsed);
        assert!(d.reasons[0].contains("prod"), "{:?}", d.reasons);

        // Stamping is active now, but the instance is older than it: CLI use before the upgrade left no trace.
        let mut f = facts();
        f.instances = vec![InstanceFacts { predates_stamping: true, ..prod() }];
        let d = decide_engine(&f);
        assert_eq!(d.category, EngineCategory::StampingUnknown);
        assert!(!d.removed(false) && d.removed(true));
    }

    #[test]
    fn legacy_inferred_does_not_override_a_sharing_signal() {
        let mut f = facts();
        f.engine.record = Some(record("legacy-inferred"));
        f.independent_server_running = true;
        assert_eq!(decide_engine(&f).category, EngineCategory::Shared);
    }

    #[test]
    fn the_record_parser_rejects_other_schemas_and_garbage() {
        let ok = r#"{"schema":1,"origin":"desktop","venv":"v","venvVolume":"7","venvFileId":"100","receiptSha256":"aaa","desktopVersion":"0.2.60","installedAt":"T"}"#;
        assert_eq!(OwnershipRecord::parse(ok).unwrap().venv_file_id.as_deref(), Some("100"));
        assert!(OwnershipRecord::parse(&ok.replace("\"schema\":1", "\"schema\":2")).is_none());
        assert!(OwnershipRecord::parse("{ truncated").is_none());
        assert!(OwnershipRecord::parse(r#"{"schema":1}"#).is_none());
        assert!(OwnershipRecord::parse(&format!("\u{feff}{ok}")).is_some(), "a byte-order mark is tolerated");
    }

    #[test]
    fn instance_data_offers() {
        assert_eq!(decide_instance(&prod(), true).offer, DataOffer::Offered);
        assert_eq!(decide_instance(&prod(), false).offer, DataOffer::OfferedWithWarning);
        let old = InstanceFacts { predates_stamping: true, ..prod() };
        assert_eq!(decide_instance(&old, true).offer, DataOffer::OfferedWithWarning);
        let cli = InstanceFacts { cli_used: true, ..prod() };
        assert!(matches!(decide_instance(&cli, true).offer, DataOffer::NotOffered(r) if r.contains("command line")));
        let cli_unknown = InstanceFacts { cli_used: true, ..prod() };
        assert!(matches!(decide_instance(&cli_unknown, false).offer, DataOffer::NotOffered(_)), "use beats unknown");
        let dev = InstanceFacts { name: "oss".into(), desktop_managed: false, cli_used: false, predates_stamping: false };
        assert!(matches!(decide_instance(&dev, true).offer, DataOffer::NotOffered(r) if r.contains("not managed")));
    }

    fn runtime() -> RuntimeFacts {
        RuntimeFacts {
            state_token: Some("tok".into()),
            state_version: Some("3.11.9".into()),
            dirs: vec![
                RuntimeDirFacts { name: "python-3.11.9".into(), sentinel_token: Some("tok".into()), ..Default::default() },
                RuntimeDirFacts { name: "downloads".into(), sentinel_token: Some("tok".into()), ..Default::default() },
            ],
            used_by_another_environment: false,
        }
    }

    fn actions(d: Vec<RuntimeDecision>) -> Vec<RuntimeAction> {
        d.into_iter().map(|x| x.action).collect()
    }

    #[test]
    fn a_marked_runtime_goes_with_its_engine() {
        assert_eq!(actions(decide_runtime(&runtime(), true)), vec![RuntimeAction::RemoveDir, RuntimeAction::RemoveDir]);
    }

    #[test]
    fn the_runtime_stays_while_its_engine_stays_or_another_environment_uses_it() {
        assert!(actions(decide_runtime(&runtime(), false)).iter().all(|a| matches!(a, RuntimeAction::Keep(_))));
        let mut r = runtime();
        r.used_by_another_environment = true;
        assert!(actions(decide_runtime(&r, true)).iter().all(|a| matches!(a, RuntimeAction::Keep(_))));
    }

    #[test]
    fn a_wrong_or_missing_token_is_kept() {
        let mut r = runtime();
        r.dirs[0].sentinel_token = Some("someone-else".into());
        r.dirs[1].sentinel_token = None;
        r.dirs[1].files = vec!["notes.txt".into()];
        assert!(actions(decide_runtime(&r, true)).iter().all(|a| matches!(a, RuntimeAction::Keep(_))));
        let mut r = runtime();
        r.state_token = None;
        assert!(actions(decide_runtime(&r, true)).iter().all(|a| matches!(a, RuntimeAction::Keep(_))), "no record: nothing proven");
    }

    #[test]
    fn a_link_is_never_proven_even_with_a_matching_token() {
        let mut r = runtime();
        r.dirs[0].link = true;
        assert!(matches!(&actions(decide_runtime(&r, true))[0], RuntimeAction::Keep(why) if why.contains("junction")));
    }

    #[test]
    fn a_legacy_runtime_needs_the_exact_folder_and_a_psf_signature() {
        let mut r = runtime();
        r.state_token = None;
        r.dirs = vec![
            RuntimeDirFacts { name: "python-3.11.9".into(), psf_signed_python: Some(true), ..Default::default() },
            RuntimeDirFacts {
                name: "downloads".into(),
                files: vec!["python.3.11.9.nupkg.zip".into(), "python.3.11.9.nupkg.zip.partial".into(), "mine.zip".into()],
                ..Default::default()
            },
            RuntimeDirFacts { name: "python-3.12.0".into(), psf_signed_python: Some(true), ..Default::default() },
        ];
        assert_eq!(
            actions(decide_runtime(&r, true)),
            vec![
                RuntimeAction::RemoveDir,
                RuntimeAction::RemoveFiles(vec!["python.3.11.9.nupkg.zip".into(), "python.3.11.9.nupkg.zip.partial".into()]),
                RuntimeAction::Keep("not proven to be FlowPad's".into()),
            ]
        );
        r.dirs[0].psf_signed_python = Some(false);
        assert!(matches!(&actions(decide_runtime(&r, true))[0], RuntimeAction::Keep(_)), "an unsigned look-alike is kept");
    }
}
