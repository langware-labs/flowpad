//! TreeWalker — the one shared walk (diskio.md §1), the inside of
//! `flow_sdk.fs_store.indexer.walk.gitignore_walk`.
//!
//! Pre-order DFS, one `on_dir` call per surviving directory. The decision
//! order per entry is the contract:
//!
//! 0. `gitignore` only: on descending into a directory its `.gitignore` and
//!    `.flowignore` are read (a symlink or an unreadable file contributes
//!    nothing); every `.flowignore` ABOVE the root is read before the walk, and
//!    a root one of them excludes has nothing under it that survives;
//! 1. type from the readdir cache — a real directory (never a symlink to one)
//!    is a dir; anything else must be a regular file after following symlinks,
//!    or it is dropped;
//! 2. basename in `deny_basenames`, or a `skip_segments` pair as consecutive
//!    path segments → ignored (files too);
//! 3. `gitignore` only, each file matched as git matches it (`gitignore.rs`):
//!    the deepest `.flowignore` with a matching line decides; failing that, an
//!    ancestor up to and including the root whose basename is in
//!    `force_include` → kept; else the deepest `.gitignore` with a matching
//!    line decides;
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

use crate::gitignore::{IgnoreFile, FLOWIGNORE, GITIGNORE};
use crate::pycompat::{lower_eq, os_bytes, py_cmp, py_suffix};

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
    /// The directory relative to the root, `/`-separated bytes; empty for the root.
    rel: Vec<u8>,
    /// Sub-directory names still to enter, reversed so `pop()` walks ascending.
    remaining: Vec<OsString>,
    /// Ignore files this directory put on the stack.
    pushed: usize,
    /// The directory or an ancestor up to the root is force-included.
    forced: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Source {
    Git,
    Flow,
}

/// One ignore file on the way down. It is asked about `prefix` followed by
/// `candidate[offset..]`: a root-relative candidate made relative to the file's
/// folder (`prefix` is non-empty only for a `.flowignore` above the root).
struct Entry {
    prefix: Vec<u8>,
    offset: usize,
    source: Source,
    file: IgnoreFile,
}

struct Walker<'p> {
    policy: &'p Policy,
    stack: Vec<Entry>,
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
    /// Every `.flowignore` above `root`, outermost first: they apply inside it too.
    /// True when one of them excludes the root (asked as git asks of a leading
    /// directory); `EXCLUDE_ALL` then stands in for the root's own rules.
    fn seed_flowignore(&mut self, root: &Path) -> bool {
        let Ok(absolute) = std::path::absolute(root) else { return false };
        let mut dir: PathBuf =
            absolute.components().take_while(|c| !matches!(c, Component::Normal(_))).collect();
        let normals: Vec<&OsStr> = absolute
            .components()
            .filter_map(|c| match c {
                Component::Normal(name) => Some(name),
                _ => None,
            })
            .collect();
        let names: Vec<Vec<u8>> = normals.iter().map(|name| os_bytes(name).into_owned()).collect();
        // (how many names deep its folder is, the file)
        let mut chain: Vec<(usize, IgnoreFile)> = Vec::new();
        for (depth, name) in normals.iter().enumerate() {
            if let Some(file) = IgnoreFile::read(&dir, FLOWIGNORE) {
                chain.push((depth, file));
            }
            let excluded = chain
                .iter()
                .rev()
                .find_map(|(at, file)| file.decide(&names[*at..=depth].join(&b'/'), true));
            if excluded == Some(true) {
                let file = IgnoreFile::exclude_all();
                self.stack.push(Entry { prefix: Vec::new(), offset: 0, source: Source::Flow, file });
                return true;
            }
            dir.push(name);
        }
        for (at, file) in chain {
            let mut prefix = names[at..].join(&b'/');
            prefix.push(b'/');
            self.stack.push(Entry { prefix, offset: 0, source: Source::Flow, file });
        }
        false
    }

    /// Push `dir`'s `.gitignore` and `.flowignore`; how many were pushed.
    fn push_ignore_files(&mut self, dir: &Path, listing: &Listing, offset: usize) -> usize {
        let mut pushed = 0;
        for (name, source) in [(GITIGNORE, Source::Git), (FLOWIGNORE, Source::Flow)] {
            // The listing says for free whether a stat could succeed at all.
            if listing.error.is_none() && !listing.may_hold(name) {
                continue;
            }
            if let Some(file) = IgnoreFile::read(dir, name) {
                self.stack.push(Entry { prefix: Vec::new(), offset, source, file });
                pushed += 1;
            }
        }
        pushed
    }

    /// The deepest `source` file with a line matching `candidate` decides.
    fn verdict(&self, candidate: &[u8], is_dir: bool, source: Source) -> Option<bool> {
        self.stack.iter().rev().filter(|entry| entry.source == source).find_map(|entry| {
            let rel = &candidate[entry.offset..];
            if entry.prefix.is_empty() {
                entry.file.decide(rel, is_dir)
            } else {
                entry.file.decide(&[entry.prefix.as_slice(), rel].concat(), is_dir)
            }
        })
    }

    /// The entries of `frame`'s directory that survive, as listing indexes.
    fn filtered(&self, dir: &Path, rel: &[u8], forced: bool, listing: &Listing) -> (Vec<usize>, Vec<usize>) {
        let policy = self.policy;
        let (mut subdirs, mut files) = (Vec::new(), Vec::new());
        let dir_name = dir.file_name();
        let mut candidate: Vec<u8> = Vec::with_capacity(rel.len() + 64);
        if !rel.is_empty() {
            candidate.extend_from_slice(rel);
            candidate.push(b'/');
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
            if policy.gitignore && !self.stack.is_empty() {
                candidate.truncate(prefix);
                candidate.extend_from_slice(&os_bytes(&ent.name));
                let ignored = match self.verdict(&candidate, is_dir, Source::Flow) {
                    Some(verdict) => verdict,
                    None => {
                        !forced
                            && !policy.force_include.contains(&ent.name)
                            && self.verdict(&candidate, is_dir, Source::Git) == Some(true)
                    }
                };
                if ignored {
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
    let root_excluded = policy.gitignore && walker.seed_flowignore(root);

    let mut frames: Vec<Frame> = Vec::new();
    let mut next: Option<(PathBuf, Vec<u8>, bool)> = Some((
        root.to_path_buf(),
        Vec::new(),
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
                            os_bytes(&name).into_owned()
                        } else {
                            [frame.rel.as_slice(), b"/", &os_bytes(&name)].concat()
                        };
                        let forced = frame.forced || policy.force_include.contains(&name);
                        (frame.dir.join(&name), rel, forced)
                    }
                    None => {
                        let keep = walker.stack.len() - frame.pushed;
                        walker.stack.truncate(keep);
                        frames.pop();
                        continue;
                    }
                }
            }
        };
        let listing = list_dir(&dir);
        let offset = if rel.is_empty() { 0 } else { rel.len() + 1 };
        let pushed = if policy.gitignore && !(rel.is_empty() && root_excluded) {
            walker.push_ignore_files(&dir, &listing, offset)
        } else {
            0
        };
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
