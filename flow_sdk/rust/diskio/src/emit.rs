//! The NDJSON line writer: one `Tagged` line per value (`{"spec_kind": …,
//! ...fields}`), then ONE `diskio.stream_end` whose counts say how many lines
//! of each kind were written (diskio.md §0 Transport).
//!
//! Lines are assembled by hand, not by `serde_json`: a path may hold bytes that
//! are not UTF-8, and those leave as `\udcXX` escapes (§0 Encoding).

use std::ffi::OsStr;
use std::io::{self, Write};
use std::path::Path;

use crate::contract as c;
use crate::pycompat::{errno_name, write_json_bytes, write_json_os};
use crate::scan::Layout;

/// Flush at least this often (§0 Streaming).
const FLUSH_EVERY: u64 = 256;

pub struct Emitter<W: Write> {
    out: W,
    line: Vec<u8>,
    walk_entries: u64,
    candidates: u64,
    problems: u64,
}

fn key(line: &mut Vec<u8>, first: bool, name: &str) {
    if !first {
        line.push(b',');
    }
    write_json_bytes(line, name.as_bytes());
    line.push(b':');
}

fn text_field(line: &mut Vec<u8>, first: bool, name: &str, value: &str) {
    key(line, first, name);
    write_json_bytes(line, value.as_bytes());
}

fn path_field(line: &mut Vec<u8>, name: &str, value: &Path) {
    key(line, false, name);
    write_json_os(line, value.as_os_str());
}

impl<W: Write> Emitter<W> {
    pub fn new(out: W) -> Self {
        Emitter { out, line: Vec::with_capacity(4096), walk_entries: 0, candidates: 0, problems: 0 }
    }

    fn open(&mut self, kind: &str) {
        self.line.clear();
        self.line.push(b'{');
        text_field(&mut self.line, true, c::TAG, kind);
    }

    fn close(&mut self) -> io::Result<()> {
        self.line.extend_from_slice(b"}\n");
        self.out.write_all(&self.line)?;
        if (self.walk_entries + self.candidates + self.problems).is_multiple_of(FLUSH_EVERY) {
            self.out.flush()?;
        }
        Ok(())
    }

    /// One surviving directory: its path, the NAMES of its sub-directories and
    /// files, and why it could not be listed (then both lists are empty).
    pub fn walk_entry<'a>(
        &mut self,
        dir: &Path,
        subdirs: impl Iterator<Item = &'a OsStr>,
        files: impl Iterator<Item = &'a OsStr>,
        error: Option<&io::Error>,
    ) -> io::Result<()> {
        use c::walk_entry as f;
        self.open(c::KIND_WALK_ENTRY);
        path_field(&mut self.line, f::DIR, dir);
        for (name, values) in [
            (f::SUBDIRS, &mut subdirs.collect::<Vec<_>>()),
            (f::FILES, &mut files.collect::<Vec<_>>()),
        ] {
            key(&mut self.line, false, name);
            self.line.push(b'[');
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    self.line.push(b',');
                }
                write_json_os(&mut self.line, value);
            }
            self.line.push(b']');
        }
        key(&mut self.line, false, f::ERROR);
        match error {
            None => self.line.extend_from_slice(b"null"),
            Some(error) => {
                use c::item_error as e;
                self.line.push(b'{');
                key(&mut self.line, true, e::PATH);
                write_json_os(&mut self.line, dir.as_os_str());
                text_field(&mut self.line, false, e::KIND, e::KIND_UNREADABLE);
                text_field(&mut self.line, false, e::DETAIL, &errno_name(error));
                self.line.push(b'}');
            }
        }
        self.walk_entries += 1;
        self.close()
    }

    pub fn candidate(&mut self, path: &Path, type_name: &str, layout: Layout, parent: &Path) -> io::Result<()> {
        use c::scan_candidate as f;
        self.open(c::KIND_SCAN_CANDIDATE);
        path_field(&mut self.line, f::PATH, path);
        text_field(&mut self.line, false, f::TYPE_NAME, type_name);
        let layout = match layout {
            Layout::File => f::LAYOUT_FILE,
            Layout::Folder => f::LAYOUT_FOLDER,
            Layout::MainFile => f::LAYOUT_MAIN_FILE,
        };
        text_field(&mut self.line, false, f::LAYOUT, layout);
        path_field(&mut self.line, f::PARENT, parent);
        self.candidates += 1;
        self.close()
    }

    pub fn problem(&mut self, path: &Path, type_name: &str, message: &str) -> io::Result<()> {
        use c::scan_problem as f;
        self.open(c::KIND_SCAN_PROBLEM);
        path_field(&mut self.line, f::PATH, path);
        text_field(&mut self.line, false, f::TYPE_NAME, type_name);
        text_field(&mut self.line, false, f::MESSAGE, message);
        self.problems += 1;
        self.close()
    }

    /// The terminal line: the line count of each of the three kinds, zero included (§13).
    pub fn finish(mut self) -> io::Result<()> {
        self.open(c::KIND_STREAM_END);
        key(&mut self.line, false, c::stream_end::COUNTS);
        self.line.push(b'{');
        let counts = [
            (c::KIND_WALK_ENTRY, self.walk_entries),
            (c::KIND_SCAN_CANDIDATE, self.candidates),
            (c::KIND_SCAN_PROBLEM, self.problems),
        ];
        let mut first = true;
        for (kind, count) in counts {
            key(&mut self.line, first, kind);
            self.line.extend_from_slice(count.to_string().as_bytes());
            first = false;
        }
        self.line.extend_from_slice(b"}}\n");
        self.out.write_all(&self.line)?;
        self.out.flush()
    }
}
