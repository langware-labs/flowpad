//! The wire contract of the stage-1 scan child, in ONE place.
//!
//! Every tag and field name the binary reads or writes is a constant here, and
//! mirrors `flow_sdk/diskio/contract.py` (whose value classes live in
//! `flow_sdk/schema/data_spec/diskio_spec.py`). A change to either list is a
//! `CONTRACT_VERSION` bump on both sides (diskio.md §0 Values).

pub const CONTRACT_VERSION: u32 = 1;

/// The envelope key of a `Tagged` value (`flow_sdk/schema/data_spec/spec.py`).
pub const TAG: &str = "spec_kind";

pub const KIND_WALK_ENTRY: &str = "diskio.walk_entry";
pub const KIND_SCAN_CANDIDATE: &str = "diskio.scan_candidate";
pub const KIND_SCAN_PROBLEM: &str = "diskio.scan_problem";
pub const KIND_STREAM_END: &str = "diskio.stream_end";

// ── output fields ────────────────────────────────────────────────────────────
pub mod walk_entry {
    pub const DIR: &str = "dir";
    pub const SUBDIRS: &str = "subdirs";
    pub const FILES: &str = "files";
    pub const ERROR: &str = "error";
}
pub mod item_error {
    pub const PATH: &str = "path";
    pub const KIND: &str = "kind";
    pub const DETAIL: &str = "detail";
    pub const KIND_UNREADABLE: &str = "unreadable";
}
pub mod scan_candidate {
    pub const PATH: &str = "path";
    pub const TYPE_NAME: &str = "type_name";
    pub const LAYOUT: &str = "layout";
    pub const PARENT: &str = "parent";
    pub const LAYOUT_FILE: &str = "file";
    pub const LAYOUT_FOLDER: &str = "folder";
    pub const LAYOUT_MAIN_FILE: &str = "main_file";
}
pub mod scan_problem {
    pub const PATH: &str = "path";
    pub const TYPE_NAME: &str = "type_name";
    pub const MESSAGE: &str = "message";
}
pub mod stream_end {
    pub const COUNTS: &str = "counts";
}

// ── request fields (ScanRequest and what it holds) ───────────────────────────
pub mod scan_request {
    pub const ROOTS: &str = "roots";
    pub const POLICY: &str = "policy";
    pub const SPECS: &str = "specs";
    pub const THREADS: &str = "threads";
}
pub mod scan_root {
    pub const PATH: &str = "path";
    pub const KIND: &str = "kind";
}
pub mod walk_policy {
    pub const GITIGNORE: &str = "gitignore";
    pub const FILE_EXTS: &str = "file_exts";
    pub const DENY_BASENAMES: &str = "deny_basenames";
    pub const SKIP_SEGMENTS: &str = "skip_segments";
    pub const FORCE_INCLUDE: &str = "force_include";
}
pub mod type_scan_spec {
    pub const TYPE_NAME: &str = "type_name";
    pub const SHAPE: &str = "shape";
    pub const WALKS: &str = "walks";
}
pub mod shape {
    pub const KIND: &str = "kind";
    pub const EXT: &str = "ext";
    pub const MAIN: &str = "main";
    pub const ALSO: &str = "also";
    pub const KIND_FILE: &str = "file";
    pub const KIND_FOLDER: &str = "folder";
}
pub mod walk_spec {
    pub const ROOTS: &str = "roots";
    pub const MOUNTS: &str = "mounts";
    pub const RECURSIVE: &str = "recursive";
    pub const ANYWHERE: &str = "anywhere";
}

/// The root kind a folder-rooted `WalkSpec` names: it runs against every
/// `WalkEntry` instead of once per root (diskio.md §13).
pub const ROOT_KIND_FOLDER: &str = "folder";
