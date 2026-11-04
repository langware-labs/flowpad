//! Handle-relative, no-follow deletion of a tree FlowPad owns (FLOWPAD-2250, Phase 0 approach B).
//!
//! A [`Root`] is opened only through the gate in [`Root::open`]: the path must not be a reparse
//! point, and its final path — which resolves every junction or symlink at any ancestor — must
//! equal the lexical path. The root is then held so nobody can move it, and everything below it is
//! opened relative to its parent's handle without following reparse points, re-checked on the
//! handle actually opened, and deleted by that handle. So:
//!
//! * a junction or symlink anywhere in the tree is removed as a link; its target is never touched,
//!   even when it appears mid-run (a swap of a directory for a junction is caught on the handle);
//! * a name swapped after it was opened cannot redirect the delete — the opened object goes;
//! * nothing is deleted by re-resolving a path string from the root;
//! * ACLs are never changed: an item the ACL denies is reported, not forced.
//!
//! One locked item never stops the walk; every item that could not go is reported. An evidence
//! file (the receipt or ownership sentinel that proves the tree is FlowPad's) can be kept until
//! everything else is gone, so a later cleanup can still prove ownership of what remains.

use std::path::{Path, PathBuf};

use super::fsx::{self, Handle, Identity, OsError};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureKind {
    /// Held open by someone else without sharing delete, or a running executable.
    Locked,
    /// The ACL denies deleting it.
    AccessDenied,
    Other,
}

#[derive(Debug, Clone)]
pub struct Failure {
    pub path: PathBuf,
    pub kind: FailureKind,
    pub detail: String,
}

/// Why a root was not opened. Nothing under a refused root is touched.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refused {
    Missing,
    /// Held open by someone else right now (a sharing or lock violation): worth trying again.
    Busy(String),
    /// Cannot be opened, and nothing says it will change (access denied by its ACL, ...).
    Unreadable(String),
    /// A file where the folder was.
    NotADirectory,
    /// The root itself is a junction or symlink.
    ReparsePoint,
    /// A junction or symlink somewhere above the root sends it elsewhere.
    Redirected { lexical: PathBuf, actual: PathBuf },
}

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Refused::Missing => write!(f, "does not exist"),
            Refused::Busy(e) => write!(f, "is in use: {e}"),
            Refused::Unreadable(e) => write!(f, "cannot be opened: {e}"),
            Refused::NotADirectory => write!(f, "is a file, not a folder"),
            Refused::ReparsePoint => write!(f, "is a junction or symbolic link"),
            Refused::Redirected { actual, .. } => write!(f, "is redirected to {}", actual.display()),
        }
    }
}

#[derive(Debug, Default)]
pub struct Report {
    pub removed: u64,
    pub failures: Vec<Failure>,
    /// The root's final path changed during the run (it, or an ancestor, was moved).
    pub moved_to: Option<PathBuf>,
    /// The evidence file was kept because something else could not be removed.
    pub evidence_kept: bool,
}

impl Report {
    pub fn complete(&self) -> bool {
        self.failures.is_empty() && self.moved_to.is_none() && !self.evidence_kept
    }

    /// A failure to open the item (with DELETE): access denied here is the ACL.
    fn fail(&mut self, path: PathBuf, err: OsError) {
        let kind = if err.is_locked() {
            FailureKind::Locked
        } else if err.is_access_denied() {
            FailureKind::AccessDenied
        } else {
            FailureKind::Other
        };
        self.failures.push(Failure { path, kind, detail: err.to_string() });
    }

    /// A failure to delete an item already opened with DELETE: the ACL allowed it, so access
    /// denied here means it is in use — a running executable's image (seen on the VM).
    fn fail_delete(&mut self, path: PathBuf, err: OsError) {
        let kind = if err.is_locked() || err.is_access_denied() { FailureKind::Locked } else { FailureKind::Other };
        self.failures.push(Failure { path, kind, detail: err.to_string() });
    }
}

/// A validated, held root directory.
pub struct Root {
    handle: Handle,
    path: PathBuf,
    identity: Identity,
}

impl Root {
    /// The root gate. See the module documentation.
    pub fn open(path: &Path) -> Result<Root, Refused> {
        let lexical = match fsx::long_lexical(path) {
            Ok(p) => p,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(Refused::Missing),
            Err(e) => return Err(Refused::Unreadable(e.to_string())),
        };
        let handle = fsx::open_path_no_follow(&lexical, true).map_err(|e| match e {
            OsError::Win32(2) | OsError::Win32(3) => Refused::Missing,
            // ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION: someone holds it now.
            OsError::Win32(32) | OsError::Win32(33) => Refused::Busy(e.to_string()),
            _ if e.is_locked() => Refused::Busy(e.to_string()),
            _ => Refused::Unreadable(e.to_string()),
        })?;
        let a = fsx::attrs(&handle).map_err(|e| Refused::Unreadable(e.to_string()))?;
        if a.reparse {
            return Err(Refused::ReparsePoint);
        }
        if !a.directory {
            return Err(Refused::NotADirectory);
        }
        let actual = fsx::final_path(&handle).map_err(|e| Refused::Unreadable(e.to_string()))?;
        if !fsx::same_path(&actual, &lexical) {
            return Err(Refused::Redirected { lexical, actual });
        }
        let identity = fsx::identity(&handle).map_err(|e| Refused::Unreadable(e.to_string()))?;
        Ok(Root { handle, path: lexical, identity })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn identity(&self) -> Identity {
        self.identity
    }

    /// The names directly inside the root.
    pub fn list(&self) -> Result<Vec<String>, String> {
        fsx::list_dir(&self.handle)
            .map(|names| names.iter().map(|n| String::from_utf16_lossy(n)).collect())
            .map_err(|e| e.to_string())
    }

    /// Remove everything inside the root. `evidence_last` names a file directly in the root that
    /// is removed only once everything else is gone.
    pub fn remove_contents(&self, evidence_last: Option<&str>) -> Report {
        let mut report = Report::default();
        let skip = evidence_last.map(fsx::path_to_name);
        walk(&self.handle, &self.path, skip.as_deref(), &mut report);
        if let Some(evidence) = skip {
            if report.failures.is_empty() {
                remove_one(&self.handle, &self.path, &evidence, &mut report);
            } else if fsx::open_child(&self.handle, &evidence, false).is_ok() {
                report.evidence_kept = true;
            }
        }
        self.check_not_moved(&mut report);
        report
    }

    /// Remove one named entry directly inside the root — a file, a link, or a whole tree.
    pub fn remove_child(&self, name: &str) -> Report {
        let mut report = Report::default();
        remove_one(&self.handle, &self.path, &fsx::path_to_name(name), &mut report);
        self.check_not_moved(&mut report);
        report
    }

    /// Remove the (now empty) root itself. It is opened again and removed only if it is still the
    /// very directory this root held — never a different one put in its place.
    pub fn remove_self(self) -> Result<(), String> {
        let Root { handle, path, identity } = self;
        drop(handle);
        let h = fsx::open_path_for_delete(&path).map_err(|e| e.to_string())?;
        let a = fsx::attrs(&h).map_err(|e| e.to_string())?;
        if a.reparse || fsx::identity(&h).map_err(|e| e.to_string())? != identity {
            return Err(format!("{} is no longer the directory that was emptied", path.display()));
        }
        fsx::delete_by_handle(&h).map_err(|e| e.to_string())
    }

    fn check_not_moved(&self, report: &mut Report) {
        match fsx::final_path(&self.handle) {
            Ok(now) if fsx::same_path(&now, &self.path) => {}
            Ok(now) => report.moved_to = Some(now),
            Err(_) => report.moved_to = Some(PathBuf::from("<unknown>")),
        }
    }
}

fn remove_one(parent: &Handle, parent_path: &Path, name: &[u16], report: &mut Report) {
    let path = parent_path.join(fsx::name_to_path(name));
    let child = match fsx::open_child_for_delete(parent, name) {
        Ok(h) => h,
        Err(OsError::Nt(s)) if s == 0xC000_0034_u32 as i32 => return, // already gone
        Err(e) => return report.fail(path, e),
    };
    // Authoritative: the attributes of the object actually opened, not of a listing read earlier.
    let a = match fsx::attrs(&child) {
        Ok(a) => a,
        Err(e) => return report.fail(path, e),
    };
    if a.directory && !a.reparse {
        walk(&child, &path, None, report);
    }
    match fsx::delete_by_handle(&child) {
        Ok(()) => report.removed += 1,
        // A directory that still holds a reported item: the item itself is the failure.
        Err(e) if a.directory && e.is_dir_not_empty() => {}
        Err(e) => report.fail_delete(path, e),
    }
}

fn walk(dir: &Handle, dir_path: &Path, skip: Option<&[u16]>, report: &mut Report) {
    let names = match fsx::list_dir(dir) {
        Ok(n) => n,
        Err(e) => return report.fail(dir_path.to_path_buf(), e),
    };
    for name in names {
        if skip.is_some_and(|s| s.eq_ignore_ascii_case_utf16(&name)) {
            continue;
        }
        remove_one(dir, dir_path, &name, report);
    }
}

trait Utf16Eq {
    fn eq_ignore_ascii_case_utf16(&self, other: &[u16]) -> bool;
}

impl Utf16Eq for [u16] {
    fn eq_ignore_ascii_case_utf16(&self, other: &[u16]) -> bool {
        let lower = |c: u16| if (b'A' as u16..=b'Z' as u16).contains(&c) { c + 32 } else { c };
        self.len() == other.len() && self.iter().zip(other).all(|(a, b)| lower(*a) == lower(*b))
    }
}
