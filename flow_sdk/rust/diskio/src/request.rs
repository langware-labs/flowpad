//! The `ScanRequest` — one JSON document on stdin (diskio.md §13), read field
//! by field with the names of `contract.rs`. A `spec_kind` key on any object is
//! accepted and ignored: the parent may send the `Tagged` form or the bare one.

use std::collections::HashSet;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::contract as c;
use crate::pycompat::{parts_lower, protect_lone_surrogates, py_norm_path, request_os_string};
use crate::scan::{Shape, TypeSpec, WalkSpec};
use crate::walk::Policy;

pub struct Root {
    /// `str(PurePosixPath(path))` of the path the parent sent.
    pub path: PathBuf,
    pub kind: String,
}

pub struct Request {
    pub roots: Vec<Root>,
    pub policy: Policy,
    pub specs: Vec<TypeSpec>,
    /// A CAP the backend may ignore; this one walks on one thread.
    #[allow(dead_code)]
    pub threads: u64,
}

type Parsed<T> = Result<T, String>;

fn field<'a>(value: &'a Value, owner: &str, name: &str) -> Parsed<&'a Value> {
    value.get(name).ok_or_else(|| format!("{owner}: missing field {name:?}"))
}

fn text<'a>(value: &'a Value, owner: &str, name: &str) -> Parsed<&'a str> {
    field(value, owner, name)?.as_str().ok_or_else(|| format!("{owner}.{name}: not a string"))
}

fn flag(value: &Value, owner: &str, name: &str, default: Option<bool>) -> Parsed<bool> {
    match (value.get(name), default) {
        (None | Some(Value::Null), Some(default)) => Ok(default),
        (Some(Value::Bool(b)), _) => Ok(*b),
        _ => Err(format!("{owner}.{name}: not a boolean")),
    }
}

/// A list of strings; an absent or null field is the empty list when `optional`.
fn strings(value: &Value, owner: &str, name: &str, optional: bool) -> Parsed<Vec<String>> {
    match value.get(name) {
        None | Some(Value::Null) if optional => Ok(Vec::new()),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| item.as_str().map(str::to_string).ok_or_else(|| format!("{owner}.{name}: not a list of strings")))
            .collect(),
        _ => Err(format!("{owner}.{name}: not a list of strings")),
    }
}

fn items<'a>(value: &'a Value, owner: &str, name: &str) -> Parsed<&'a Vec<Value>> {
    field(value, owner, name)?.as_array().ok_or_else(|| format!("{owner}.{name}: not a list"))
}

/// `"." + ext.lower().lstrip(".")` — `layout._norm_ext`.
fn norm_ext(ext: &str) -> String {
    format!(".{}", ext.to_lowercase().trim_start_matches('.'))
}

fn parse_policy(value: &Value) -> Parsed<Policy> {
    use c::walk_policy as f;
    let owner = "policy";
    let file_exts = match field(value, owner, f::FILE_EXTS)? {
        Value::Null => None,
        Value::Array(_) => Some(strings(value, owner, f::FILE_EXTS, false)?.iter().map(|e| e.to_lowercase()).collect()),
        _ => return Err(format!("{owner}.{}: not a list or null", f::FILE_EXTS)),
    };
    let mut skip_segments = Vec::new();
    for pair in items(value, owner, f::SKIP_SEGMENTS)? {
        match pair.as_array().map(Vec::as_slice) {
            Some([Value::String(a), Value::String(b)]) => {
                skip_segments.push((request_os_string(a), request_os_string(b)))
            }
            _ => return Err(format!("{owner}.{}: not a list of [a, b] pairs", f::SKIP_SEGMENTS)),
        }
    }
    let name_set = |name: &str| -> Parsed<HashSet<OsString>> {
        Ok(strings(value, owner, name, false)?.iter().map(|s| request_os_string(s)).collect())
    };
    Ok(Policy {
        gitignore: flag(value, owner, f::GITIGNORE, None)?,
        file_exts,
        deny_basenames: name_set(f::DENY_BASENAMES)?,
        skip_segments,
        force_include: name_set(f::FORCE_INCLUDE)?,
    })
}

fn parse_shape(value: &Value, owner: &str) -> Parsed<Shape> {
    use c::shape as f;
    let optional_text = |name: &str| -> Parsed<Option<String>> {
        match value.get(name) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(s)) => Ok(Some(s.clone())),
            _ => Err(format!("{owner}.{name}: not a string or null")),
        }
    };
    match text(value, owner, f::KIND)? {
        k if k == f::KIND_FOLDER => {
            let main = optional_text(f::MAIN)?;
            let main_lower = main.as_deref().unwrap_or("").to_lowercase();
            Ok(Shape::Folder { main, main_lower })
        }
        k if k == f::KIND_FILE => {
            let ext = norm_ext(&optional_text(f::EXT)?.ok_or_else(|| format!("{owner}.{}: a file shape needs one", f::EXT))?);
            let mut exts = vec![ext.clone()];
            exts.extend(strings(value, owner, f::ALSO, true)?.iter().map(|e| norm_ext(e)));
            Ok(Shape::File { ext, exts })
        }
        other => Err(format!("{owner}.{}: unknown shape kind {other:?}", f::KIND)),
    }
}

fn parse_spec(value: &Value) -> Parsed<TypeSpec> {
    use c::type_scan_spec as f;
    let type_name = text(value, "spec", f::TYPE_NAME)?.to_string();
    let owner = format!("spec[{type_name}]");
    let mut walks = Vec::new();
    for walk in items(value, &owner, f::WALKS)? {
        use c::walk_spec as w;
        walks.push(WalkSpec {
            roots: strings(walk, &owner, w::ROOTS, false)?,
            mounts: strings(walk, &owner, w::MOUNTS, true)?,
            recursive: flag(walk, &owner, w::RECURSIVE, Some(false))?,
            anywhere: flag(walk, &owner, w::ANYWHERE, Some(false))?,
        });
    }
    // The exporter fills `mounts` on EVERY walk, `anywhere` ones included: the
    // union is every directory a copy of the type may be in (`TypeInfo.scan_mounts`).
    let mut scan_mounts: Vec<Vec<String>> = Vec::new();
    for mount in walks.iter().flat_map(|walk| &walk.mounts) {
        let parts = parts_lower(Path::new(mount));
        if !scan_mounts.contains(&parts) {
            scan_mounts.push(parts);
        }
    }
    Ok(TypeSpec { shape: parse_shape(field(value, &owner, f::SHAPE)?, &owner)?, type_name, walks, scan_mounts })
}

/// Parse the request document. `Err` is a message for stderr; the binary exits non-zero.
pub fn parse(raw: &str) -> Parsed<Request> {
    use c::scan_request as f;
    let value: Value = serde_json::from_str(&protect_lone_surrogates(raw)).map_err(|e| format!("not JSON: {e}"))?;
    if !value.is_object() {
        return Err("the request is not a JSON object".to_string());
    }
    let mut roots = Vec::new();
    for root in items(&value, "request", f::ROOTS)? {
        roots.push(Root {
            path: py_norm_path(&request_os_string(text(root, "root", c::scan_root::PATH)?)),
            kind: text(root, "root", c::scan_root::KIND)?.to_string(),
        });
    }
    let policy = parse_policy(field(&value, "request", f::POLICY)?)?;
    let specs = items(&value, "request", f::SPECS)?.iter().map(parse_spec).collect::<Parsed<Vec<_>>>()?;
    let threads = match value.get(f::THREADS) {
        None | Some(Value::Null) => 1,
        Some(n) => n.as_u64().ok_or_else(|| format!("request.{}: not a non-negative integer", f::THREADS))?,
    };
    Ok(Request { roots, policy, specs, threads })
}
