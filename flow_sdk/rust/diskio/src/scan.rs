//! DeclaredScanner — typed candidate discovery (diskio.md §3), the inside of
//! `flow_sdk.assets.scanning.scan_declared`.
//!
//! One call scans one root for one type: its walks in declaration order, an
//! `anywhere` walk over the root itself, then each mount, entries sorted as
//! `pathlib` sorts paths. A candidate is emitted once (`first_seen`); a
//! non-dot sub-directory of a non-recursive folder mount that lacks the main
//! document is a problem. A mount that cannot be LISTED is silently empty; a
//! mount that cannot be STATTED is a problem carrying `str(OSError)`.
//!
//! Where Python would raise out of the whole scan (a stat that fails with
//! EACCES outside the one guarded place), the answer here is "not a file" /
//! "not a directory" and the scan goes on.

use std::collections::HashSet;
use std::ffi::OsStr;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

use crate::pycompat::{
    is_appledouble, lower_eq, os_bytes, py_cmp_paths, py_ignored_error, py_oserror_str, py_suffix,
};
use crate::walk::{list_dir, Kind, Listing};

pub enum Shape {
    /// A single file, told apart by extension: `ext`, or any of `exts` (`ext` first).
    File { ext: String, exts: Vec<String> },
    /// A directory, told apart by the main document it holds.
    Folder { main: Option<String>, main_lower: String },
}

pub struct WalkSpec {
    pub roots: Vec<String>,
    pub mounts: Vec<String>,
    pub recursive: bool,
    pub anywhere: bool,
}

pub struct TypeSpec {
    pub type_name: String,
    pub shape: Shape,
    pub walks: Vec<WalkSpec>,
    /// The union of the walks' mounts, as lowercase parts — `TypeInfo.scan_mounts`:
    /// what an `anywhere` entry is skipped for being under.
    pub scan_mounts: Vec<Vec<String>>,
}

impl TypeSpec {
    pub fn walks_root(&self, root_type: &str) -> bool {
        self.walks.iter().any(|walk| walk.roots.iter().any(|r| r == root_type))
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Layout {
    File,
    Folder,
    MainFile,
}

#[derive(Default)]
pub struct Found {
    pub candidates: Vec<(PathBuf, Layout)>,
    pub problems: Vec<(PathBuf, String)>,
}

/// `Path.is_dir()` (3.11): false for a path that is not there, an error for any other failure.
fn py_is_dir(path: &Path) -> io::Result<bool> {
    match fs::metadata(path) {
        Ok(meta) => Ok(meta.is_dir()),
        Err(error) if py_ignored_error(&error) => Ok(false),
        Err(error) => Err(error),
    }
}

fn is_dir(path: &Path) -> bool {
    fs::metadata(path).map(|m| m.is_dir()).unwrap_or(false)
}

fn is_file(path: &Path) -> bool {
    fs::metadata(path).map(|m| m.is_file()).unwrap_or(false)
}

fn name_of(path: &Path) -> &OsStr {
    path.file_name().unwrap_or(OsStr::new(""))
}

/// `placement.mount_matches(path.parent.parts, mount.parts)` for any of the type's mounts.
fn under_mount(parent: Option<&Path>, mounts: &[Vec<String>]) -> bool {
    let Some(parent) = parent else { return false };
    mounts.iter().any(|mount| {
        if mount.is_empty() {
            return false;
        }
        let mut parts = parent.components().rev().filter(|c| !matches!(c, Component::CurDir));
        mount.iter().rev().all(|want| match parts.next() {
            Some(part) => want == "*" || lower_eq(part.as_os_str(), want),
            None => false,
        })
    })
}

impl Shape {
    /// `shape.locate(path, verify=True)`: the layout and the asset root, or `None`.
    /// `kind` is the entry's type when the WALK's listing already told it; an
    /// entry of a mount is always statted, as Python stats it.
    fn locate(&self, path: &Path, kind: Option<Kind>) -> Option<(Layout, PathBuf)> {
        let name = name_of(path);
        match self {
            Shape::File { exts, .. } => {
                let bytes = os_bytes(name);
                let shaped = exts.contains(&String::from_utf8_lossy(py_suffix(&bytes)).to_lowercase());
                // Always the stat Python makes, unless the listing already says "a directory".
                let exists = shaped && kind != Some(Kind::Dir) && is_file(path);
                exists.then(|| (Layout::File, path.to_path_buf()))
            }
            Shape::Folder { main, main_lower } => {
                let main = main.as_deref().filter(|m| !m.is_empty());
                let path_is_dir = match kind {
                    Some(Kind::Dir) => true,
                    Some(Kind::File) => false,
                    _ => is_dir(path),
                };
                if main.is_some() && lower_eq(name, main_lower) && !path_is_dir {
                    return Some((Layout::MainFile, path.parent().unwrap_or(path).to_path_buf()));
                }
                let main = main?;
                (path_is_dir && is_file(&path.join(main))).then(|| (Layout::Folder, path.to_path_buf()))
            }
        }
    }
}

/// `Path.rglob(pattern)` (3.11): every descendant whose name ends with `ext`
/// (all of them for `None`); a symlinked directory is listed but not entered.
fn rglob(dir: &Path, ext: Option<&[u8]>, out: &mut Vec<PathBuf>) {
    let Ok(read) = fs::read_dir(dir) else { return };
    let mut subdirs = Vec::new();
    for entry in read.flatten() {
        let name = entry.file_name();
        let path = dir.join(&name);
        if ext.is_none_or(|ext| os_bytes(&name).ends_with(ext)) {
            out.push(path.clone());
        }
        if entry.file_type().is_ok_and(|t| t.is_dir()) {
            subdirs.push(path);
        }
    }
    for sub in subdirs {
        rglob(&sub, ext, out);
    }
}

/// `scanning.directory_candidates`: the entries a scan considers under `mount`.
/// With the walk's `listing` of `mount` in hand, nothing is read again and each
/// entry carries its type. `Err` only when the mount's own stat fails.
fn directory_candidates(
    mount: &Path, shape: &Shape, recursive: bool, listing: Option<&Listing>,
) -> io::Result<Vec<(PathBuf, Option<Kind>)>> {
    if listing.is_none() && !py_is_dir(mount)? {
        return Ok(Vec::new());
    }
    if recursive {
        let ext = match shape {
            Shape::File { ext, .. } => Some(ext.as_bytes()),
            Shape::Folder { .. } => None,
        };
        let mut found = Vec::new();
        rglob(mount, ext, &mut found);
        found.sort_by(|a, b| py_cmp_paths(a, b));
        return Ok(found.into_iter().map(|p| (p, None)).collect());
    }
    // An unreadable mount has an empty listing: silently no entries.
    Ok(match listing {
        Some(listing) => listing
            .ents
            .iter()
            .map(|e| (mount.join(&e.name), Some(e.kind).filter(|k| *k != Kind::Unknown)))
            .collect(),
        None => list_dir(mount).ents.iter().map(|e| (mount.join(&e.name), None)).collect(),
    })
}

/// One `*`/`?` wildcard segment against a name, case-sensitive (`fnmatch` on POSIX).
fn segment_matches(pattern: &[u8], name: &[u8]) -> bool {
    match pattern.split_first() {
        None => name.is_empty(),
        Some((b'*', rest)) => (0..=name.len()).any(|k| segment_matches(rest, &name[k..])),
        Some((b'?', rest)) => !name.is_empty() && segment_matches(rest, &name[1..]),
        Some((c, rest)) => name.first() == Some(c) && segment_matches(rest, &name[1..]),
    }
}

/// `sorted(p for p in root.glob(mount) if p.is_dir())`.
fn glob_mount(root: &Path, mount: &str) -> Vec<PathBuf> {
    if !is_dir(root) {
        return Vec::new();
    }
    let segments: Vec<&str> = mount.split('/').filter(|s| !s.is_empty() && *s != ".").collect();
    let mut current = vec![root.to_path_buf()];
    for (index, segment) in segments.iter().enumerate() {
        let last = index + 1 == segments.len();
        let mut next = Vec::new();
        for base in &current {
            if !segment.contains(['*', '?']) {
                let path = base.join(segment);
                if if last { fs::metadata(&path).is_ok() } else { is_dir(&path) } {
                    next.push(path);
                }
                continue;
            }
            for ent in list_dir(base).ents {
                if !segment_matches(segment.as_bytes(), &os_bytes(&ent.name)) {
                    continue;
                }
                let path = base.join(&ent.name);
                if last || ent.kind == Kind::Dir || (ent.kind != Kind::File && is_dir(&path)) {
                    next.push(path);
                }
            }
        }
        current = next;
    }
    let mut dirs: Vec<PathBuf> = current.into_iter().filter(|p| is_dir(p)).collect();
    dirs.sort_by(|a, b| py_cmp_paths(a, b));
    dirs
}

/// `first_seen`'s key: the path as written, or RESOLVED when the mount is a symlink.
fn seen_key(path: &Path, resolve: bool) -> Vec<u8> {
    let resolved;
    let path = if resolve {
        resolved = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        &resolved
    } else {
        path
    };
    let bytes = os_bytes(path.as_os_str()).into_owned();
    if cfg!(windows) {
        // os.path.normcase
        return String::from_utf8_lossy(&bytes).to_lowercase().replace('/', "\\").into_bytes();
    }
    bytes
}

/// `scan_declared(info, root, root_type)`. `listing` is the root's own listing
/// when the caller has just read it (the walk has, for every directory it yields).
pub fn scan_declared(spec: &TypeSpec, root: &Path, root_type: &str, listing: Option<&Listing>) -> Found {
    let mut found = Found::default();
    let mut seen: HashSet<Vec<u8>> = HashSet::new();
    let shape = &spec.shape;
    let is_folder = matches!(shape, Shape::Folder { .. });

    let mut emit = |found: &mut Found, path: &Path, kind: Option<Kind>, resolve: bool| -> bool {
        let Some((layout, asset_root)) = shape.locate(path, kind) else { return false };
        if seen.insert(seen_key(&asset_root, resolve)) {
            found.candidates.push((asset_root, layout));
        }
        true
    };

    for walk in &spec.walks {
        if !walk.roots.iter().any(|r| r == root_type) {
            continue;
        }
        if walk.anywhere {
            if is_folder {
                // The node ITSELF is the asset.
                if !is_appledouble(name_of(root)) && !under_mount(root.parent(), &spec.scan_mounts) {
                    if let Shape::Folder { main_lower, .. } = shape {
                        // The listing rules the main document out without a stat.
                        if listing.is_some_and(|l| l.error.is_none() && !l.may_hold(main_lower)) {
                            continue;
                        }
                    }
                    emit(&mut found, root, listing.map(|_| Kind::Dir), false);
                }
            } else if !under_mount(Some(root), &spec.scan_mounts) {
                // The node's direct children; every one of them has `root` as its parent.
                for (entry, kind) in directory_candidates(root, shape, false, listing).unwrap_or_default() {
                    if !is_appledouble(name_of(&entry)) {
                        emit(&mut found, &entry, kind, false);
                    }
                }
            }
            continue;
        }
        for mount in &walk.mounts {
            let directories = if mount.contains('*') { glob_mount(root, mount) } else { vec![root.join(mount)] };
            for directory in directories {
                let entries = match directory_candidates(&directory, shape, walk.recursive, None) {
                    Ok(entries) => entries,
                    Err(error) => {
                        found.problems.push((directory.clone(), py_oserror_str(&error, &directory)));
                        continue;
                    }
                };
                if entries.is_empty() {
                    continue;
                }
                let resolve = fs::symlink_metadata(&directory).is_ok_and(|m| m.file_type().is_symlink());
                for (entry, _) in entries {
                    let name = name_of(&entry);
                    if is_appledouble(name) || emit(&mut found, &entry, None, resolve) {
                        continue;
                    }
                    if let Shape::Folder { main, .. } = shape {
                        let dot = os_bytes(name).starts_with(b".");
                        if !walk.recursive && !dot && is_dir(&entry) {
                            found.problems.push((
                                entry.clone(),
                                format!(
                                    "directory in {}/ without {}",
                                    name_of(&directory).to_string_lossy(),
                                    main.as_deref().unwrap_or("None"),
                                ),
                            ));
                        }
                    }
                }
            }
        }
    }
    found
}
