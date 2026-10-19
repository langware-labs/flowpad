//! TreeWalker — the one shared walk (diskio.md §1), the inside of
//! `flow_sdk.fs_store.indexer.walk.gitignore_walk`.
//!
//! Pre-order DFS, one `on_dir` call per surviving directory. The decision
//! order per entry is the contract:
//!
//! 0. on descending into a directory its `.gitignore` is read (UTF-8, U+FFFD
//!    for bad bytes); an unparseable line is dropped, an unreadable file
//!    contributes nothing;
//! 1. type from the readdir cache — a real directory (never a symlink to one)
//!    is a dir; anything else must be a regular file after following symlinks,
//!    or it is dropped;
//! 2. basename in `deny_basenames`, or a `skip_segments` pair as consecutive
//!    path segments → ignored (files too);
//! 3. `gitignore` only: an ancestor up to and including the root whose
//!    basename is in `force_include` → kept; else the `.gitignore` stack,
//!    a directory tried as `rel/` and as `rel`, one file's "ignore" enough;
//! 4. a surviving file is listed only if `file_exts` admits its suffix
//!    (`PurePath.suffix`, case-insensitive).
//!
//! The root is walked as given and always yielded. A symlinked directory is
//! never followed. An unreadable directory yields with empty lists and its errno.

use std::collections::HashSet;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

use crate::gitignore::Spec;
use crate::pycompat::{lower_eq, match_text, os_bytes, py_cmp, py_suffix};

/// `WalkPolicy`, as sets.
pub struct Policy {
    pub gitignore: bool,
    /// `None` = every file; empty = no files; else the lowercase suffixes (`PurePath.suffix`) admitted.
    pub file_exts: Option<Vec<String>>,
    pub deny_basenames: HashSet<OsString>,
    pub skip_segments: Vec<(OsString, OsString)>,
    pub force_include: HashSet<OsString>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    /// A real directory (not a symlink to one).
    Dir,
    File,
    Symlink,
    Other,
    /// The entry's type could not be read.
    Unknown,
}

pub struct Ent {
    pub name: OsString,
    pub kind: Kind,
}

/// Every entry of one directory, sorted by name as Python sorts `str`.
#[derive(Default)]
pub struct Listing {
    pub ents: Vec<Ent>,
    pub error: Option<io::Error>,
}

impl Listing {
    /// Could `dir/<name>` exist, by a case-insensitive look at the listing?
    /// `false` is certain on any filesystem for an ASCII name; `true` needs a stat.
    pub fn may_hold(&self, name_lower: &str) -> bool {
        self.ents.iter().any(|e| lower_eq(&e.name, name_lower))
    }
}

pub fn list_dir(dir: &Path) -> Listing {
    let read = match fs::read_dir(dir) {
        Ok(read) => read,
        Err(error) => return Listing { ents: Vec::new(), error: Some(error) },
    };
    let mut ents = Vec::new();
    for entry in read {
        match entry {
            Ok(entry) => {
                let kind = match entry.file_type() {
                    Ok(t) if t.is_dir() => Kind::Dir,
                    Ok(t) if t.is_file() => Kind::File,
                    Ok(t) if t.is_symlink() => Kind::Symlink,
                    Ok(_) => Kind::Other,
                    Err(_) => Kind::Unknown,
                };
                ents.push(Ent { name: entry.file_name(), kind });
            }
            // A listing that fails part-way is an unreadable directory: Python's
            // `list(scandir)` raises and the walk yields it empty.
            Err(error) => return Listing { ents: Vec::new(), error: Some(error) },
        }
    }
    ents.sort_by(|a, b| py_cmp(&a.name, &b.name));
    Listing { ents, error: None }
}

/// One surviving directory, as `on_dir` receives it.
pub struct Visit<'a> {
    pub dir: &'a Path,
    /// Every entry of the directory — what a declared scan of it re-reads.
    pub listing: &'a Listing,
    /// Indexes into `listing.ents`: the sub-directories the walk will enter.
    pub subdirs: &'a [usize],
    pub files: &'a [usize],
}

struct Frame {
    dir: PathBuf,
    /// The directory relative to the root, as match text; empty for the root.
    rel: String,
    /// Sub-directory names still to enter, reversed so `pop()` walks ascending.
    remaining: Vec<OsString>,
    pushed: bool,
    /// The directory or an ancestor up to the root is force-included.
    forced: bool,
}

struct Walker<'p> {
    policy: &'p Policy,
    /// `(offset, spec)`: the `.gitignore` of a directory, and where a path
    /// relative to that directory starts inside a root-relative candidate.
    stack: Vec<(usize, Spec)>,
    /// A `skip_segments` pair sits in the root path itself: everything is ignored.
    root_skipped: bool,
}

/// `PurePath(name).suffix.lower() in exts` — a dotfile named `.md` has no suffix.
fn has_suffix(name: &OsStr, exts: &[String]) -> bool {
    let bytes = os_bytes(name);
    let suffix = py_suffix(&bytes);
    if suffix.is_empty() {
        return false;
    }
    let suffix = String::from_utf8_lossy(suffix).to_lowercase();
    exts.contains(&suffix)
}

impl Walker<'_> {
    fn push_gitignore(&mut self, dir: &Path, listing: &Listing, offset: usize) -> bool {
        // The listing says for free whether a stat could succeed at all.
        if listing.error.is_none() && !listing.may_hold(".gitignore") {
            return false;
        }
        let path = dir.join(".gitignore");
        if !fs::metadata(&path).map(|m| m.is_file()).unwrap_or(false) {
            return false;
        }
        match fs::read(&path) {
            Ok(bytes) => {
                self.stack.push((offset, Spec::from_text(&String::from_utf8_lossy(&bytes))));
                true
            }
            Err(_) => false,
        }
    }

    fn stack_ignores(&self, candidate: &str, is_dir: bool) -> bool {
        self.stack.iter().any(|(offset, spec)| {
            if spec.is_empty() {
                return false;
            }
            let rel = &candidate[*offset..];
            spec.match_file(rel) || (is_dir && spec.match_file(&rel[..rel.len() - 1]))
        })
    }

    /// The entries of `frame`'s directory that survive, as listing indexes.
    fn filtered(&self, dir: &Path, rel: &str, forced: bool, listing: &Listing) -> (Vec<usize>, Vec<usize>) {
        let policy = self.policy;
        let (mut subdirs, mut files) = (Vec::new(), Vec::new());
        let dir_name = dir.file_name();
        let mut candidate = String::with_capacity(rel.len() + 64);
        if !rel.is_empty() {
            candidate.push_str(rel);
            candidate.push('/');
        }
        let prefix = candidate.len();
        for (index, ent) in listing.ents.iter().enumerate() {
            let is_dir = ent.kind == Kind::Dir;
            if !is_dir {
                match &policy.file_exts {
                    Some(exts) if !has_suffix(&ent.name, exts) => continue, // step 4, asked early: it is the cheapest
                    _ => {}
                }
                let is_file = match ent.kind {
                    Kind::File => true,
                    Kind::Symlink => fs::metadata(dir.join(&ent.name)).map(|m| m.is_file()).unwrap_or(false),
                    _ => false,
                };
                if !is_file {
                    continue;
                }
            }
            // step 2
            if policy.deny_basenames.contains(&ent.name)
                || self.root_skipped
                || policy.skip_segments.iter().any(|(a, b)| dir_name == Some(a.as_os_str()) && ent.name == *b)
            {
                continue;
            }
            // step 3
            if policy.gitignore && !forced && !policy.force_include.contains(&ent.name) && !self.stack.is_empty() {
                candidate.truncate(prefix);
                candidate.push_str(&match_text(&ent.name));
                if is_dir {
                    candidate.push('/');
                }
                if self.stack_ignores(&candidate, is_dir) {
                    continue;
                }
            }
            if is_dir { subdirs.push(index) } else { files.push(index) }
        }
        (subdirs, files)
    }
}

/// Walk `root` under `policy`, calling `on_dir` once per surviving directory in pre-order.
/// A root that is not a directory yields nothing, as `gitignore_walk` does.
pub fn walk(root: &Path, policy: &Policy, on_dir: &mut dyn FnMut(&Visit<'_>)) {
    if !fs::metadata(root).map(|m| m.is_dir()).unwrap_or(false) {
        return;
    }
    let names: Vec<&OsStr> = root
        .components()
        .filter_map(|c| match c {
            Component::Normal(name) => Some(name),
            _ => None,
        })
        .collect();
    let root_skipped = policy
        .skip_segments
        .iter()
        .any(|(a, b)| names.windows(2).any(|w| w[0] == a.as_os_str() && w[1] == b.as_os_str()));
    let mut walker = Walker { policy, stack: Vec::new(), root_skipped };

    let mut frames: Vec<Frame> = Vec::new();
    let mut next: Option<(PathBuf, String, bool)> = Some((
        root.to_path_buf(),
        String::new(),
        root.file_name().is_some_and(|name| policy.force_include.contains(name)),
    ));
    loop {
        let (dir, rel, forced) = match next.take() {
            Some(entry) => entry,
            None => {
                let Some(frame) = frames.last_mut() else { break };
                match frame.remaining.pop() {
                    Some(name) => {
                        let rel = if frame.rel.is_empty() {
                            match_text(&name).into_owned()
                        } else {
                            format!("{}/{}", frame.rel, match_text(&name))
                        };
                        let forced = frame.forced || policy.force_include.contains(&name);
                        (frame.dir.join(&name), rel, forced)
                    }
                    None => {
                        if frame.pushed {
                            walker.stack.pop();
                        }
                        frames.pop();
                        continue;
                    }
                }
            }
        };
        let listing = list_dir(&dir);
        let offset = if rel.is_empty() { 0 } else { rel.len() + 1 };
        let pushed = policy.gitignore && walker.push_gitignore(&dir, &listing, offset);
        let (subdirs, files) = walker.filtered(&dir, &rel, forced, &listing);
        on_dir(&Visit { dir: &dir, listing: &listing, subdirs: &subdirs, files: &files });
        let remaining = subdirs.iter().rev().map(|&i| listing.ents[i].name.clone()).collect();
        frames.push(Frame { dir, rel, remaining, pushed, forced });
    }
}

/// The names behind a visit's indexes.
pub fn names<'a>(visit: &'a Visit<'_>, indexes: &'a [usize]) -> impl Iterator<Item = &'a OsStr> + 'a {
    indexes.iter().map(|&i| visit.listing.ents[i].name.as_os_str())
}
