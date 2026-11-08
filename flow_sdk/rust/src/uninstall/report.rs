//! What an uninstall did, told honestly (FLOWPAD-2250, plan §6). There is no unconditional
//! success: the outcome is derived from the ledger of what was removed, kept and left behind.

use serde::Serialize;
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Outcome {
    /// Everything selected was removed.
    Complete,
    /// The rest is scheduled, verified, to be removed at the next sign-in.
    RestartRequired,
    /// Something was kept or could not be removed; the ledger says what and why.
    Partial,
}

impl Outcome {
    pub fn exit_code(self) -> i32 {
        match self {
            Outcome::Complete => 0,
            Outcome::RestartRequired => 10,
            Outcome::Partial => 20,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Item {
    pub what: String,
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ledger {
    /// Removed.
    pub removed: Vec<Item>,
    /// Deliberately kept: not proven FlowPad's, or used by something else. Makes the outcome Partial.
    pub kept: Vec<Item>,
    /// Could not be removed (locked, denied, redirected) and not scheduled.
    pub left: Vec<Item>,
    /// Could not be removed now; scheduled and verified for the next sign-in.
    pub pending: Vec<Item>,
    /// Found where FlowPad's files live but not created by FlowPad; left alone. Informational only.
    pub not_ours: Vec<Item>,
    /// Processes left running (not FlowPad's, or not verified). Informational.
    pub processes_left: Vec<String>,
}

impl Ledger {
    pub fn removed(&mut self, what: &str, path: &Path) {
        self.removed.push(item(what, path, ""));
    }
    pub fn kept(&mut self, what: &str, path: &Path, reason: &str) {
        self.kept.push(item(what, path, reason));
    }
    pub fn left(&mut self, what: &str, path: &Path, reason: &str) {
        self.left.push(item(what, path, reason));
    }
    pub fn not_ours(&mut self, what: &str, path: &Path) {
        self.not_ours.push(item(what, path, "not created by FlowPad"));
    }

    pub fn outcome(&self) -> Outcome {
        if !self.kept.is_empty() || !self.left.is_empty() {
            Outcome::Partial
        } else if !self.pending.is_empty() {
            Outcome::RestartRequired
        } else {
            Outcome::Complete
        }
    }

    /// The finish page's text (and the silent-mode summary): what happened, then each list.
    pub fn summary(&self) -> String {
        let mut s = String::new();
        let head = match self.outcome() {
            Outcome::Complete => "FlowPad was removed.".to_string(),
            Outcome::RestartRequired => format!(
                "FlowPad was removed. {} item(s) are in use and will be removed the next time you sign in.",
                self.pending.len()
            ),
            Outcome::Partial => "FlowPad was removed, but some items were left in place.".to_string(),
        };
        s.push_str(&head);
        s.push('\n');
        let mut section = |title: &str, items: &[Item]| {
            if items.is_empty() {
                return;
            }
            s.push_str(&format!("\n{title}:\n"));
            for i in items {
                if i.reason.is_empty() {
                    s.push_str(&format!("  - {} ({})\n", i.what, i.path));
                } else {
                    s.push_str(&format!("  - {} ({}): {}\n", i.what, i.path, i.reason));
                }
            }
        };
        section("Kept", &self.kept);
        section("Could not be removed", &self.left);
        section("Will be removed at next sign-in", &self.pending);
        s
    }
}

fn item(what: &str, path: &Path, reason: &str) -> Item {
    Item { what: what.into(), path: path.display().to_string(), reason: reason.into() }
}

/// An append-only log. Never fails the uninstall; never written with secret values.
pub struct Log {
    file: Option<std::fs::File>,
}

impl Log {
    pub fn open(path: Option<&Path>) -> Log {
        let file = path.and_then(|p| std::fs::OpenOptions::new().create(true).append(true).open(p).ok());
        Log { file }
    }

    pub fn line(&mut self, msg: &str) {
        if let Some(f) = self.file.as_mut() {
            let _ = writeln!(f, "{} {msg}", timestamp());
        }
    }
}

fn timestamp() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    format!("[{secs}]")
}

/// `result.json` (everything) and `result.txt` (the summary the finish page shows).
pub fn write_result(dir_file: &Path, outcome: Outcome, ledger: &Ledger, extra: serde_json::Value) -> std::io::Result<PathBuf> {
    let json = serde_json::json!({ "outcome": outcome, "ledger": ledger, "detail": extra });
    std::fs::write(dir_file, serde_json::to_string_pretty(&json).unwrap_or_default())?;
    let txt = dir_file.with_extension("txt");
    std::fs::write(&txt, ledger.summary())?;
    Ok(txt)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_outcome_follows_the_ledger() {
        let mut l = Ledger::default();
        l.removed("engine", Path::new("v"));
        l.not_ours("unknown file", Path::new("x"));
        assert_eq!(l.outcome(), Outcome::Complete, "items that are not FlowPad's do not count against it");
        l.pending.push(item("locked file", Path::new("p"), "in use"));
        assert_eq!(l.outcome(), Outcome::RestartRequired);
        l.kept("engine", Path::new("v"), "shared");
        assert_eq!(l.outcome(), Outcome::Partial, "anything kept or left beats pending");
        assert_eq!(Outcome::Complete.exit_code(), 0);
        assert_eq!(Outcome::RestartRequired.exit_code(), 10);
        assert_eq!(Outcome::Partial.exit_code(), 20);
    }

    #[test]
    fn the_summary_never_claims_success_it_did_not_have() {
        let mut l = Ledger::default();
        l.left("runtime", Path::new(r"C:\x"), "locked");
        let s = l.summary();
        assert!(s.starts_with("FlowPad was removed, but some items were left in place."));
        assert!(s.contains("Could not be removed") && s.contains("locked"));
        let mut l = Ledger::default();
        l.pending.push(item("venv", Path::new("v"), "in use"));
        assert!(l.summary().contains("1 item(s) are in use and will be removed the next time you sign in"));
    }
}
