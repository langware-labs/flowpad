//! `flowpad-diskio-scan` — the stage-1 scan child (docs/data-management/diskio.md §13).
//!
//! ```text
//! flowpad-diskio-scan --contract-version     # prints the contract version, exits 0
//! flowpad-diskio-scan < request.json         # one ScanRequest in, the tagged NDJSON stream out
//! ```
//!
//! For each root of the request, in order:
//!
//! 1. the root's own declared scan — `scan(root, root.kind, specs)`;
//! 2. the tree walk in pre-order, each `diskio.walk_entry` followed at once by
//!    the folder-rooted declared scan of that directory —
//!    `scan(entry.dir, "folder", folder-rooted specs)`.
//!
//! One scan writes per type in spec order, a type's candidates before its
//! problems. A line of step 1 and a line of step 2 can both carry
//! `parent == root`; coming before or after the root's `walk_entry` is what
//! tells them apart. This is the order of the Python backend
//! (`flow_sdk/diskio/python/scanner.py`), and the two are diffed line by line.
//!
//! The child reads directories and nothing else: no registry, no settings, no
//! database, no ids. stdout carries the stream, stderr carries logs, and the
//! exit code is non-zero only for a request it cannot parse or a stream it
//! cannot write.

mod contract;
mod emit;
mod gitignore;
mod pycompat;
mod request;
mod scan;
mod walk;

use std::io::{self, BufWriter, Read, Write};
use std::path::Path;
use std::process::ExitCode;

use emit::Emitter;
use request::Request;
use scan::{scan_declared, TypeSpec};
use walk::Listing;

/// One declared scan of `root`: per type in spec order, its candidates then its problems.
fn scan_into<W: Write>(
    out: &mut Emitter<W>, specs: &[&TypeSpec], root: &Path, root_type: &str, listing: Option<&Listing>,
) -> io::Result<()> {
    for spec in specs {
        let found = scan_declared(spec, root, root_type, listing);
        for (path, layout) in &found.candidates {
            out.candidate(path, &spec.type_name, *layout, root)?;
        }
        for (path, message) in &found.problems {
            out.problem(path, &spec.type_name, message)?;
        }
    }
    Ok(())
}

/// The whole stream for `request`, terminal line included.
pub fn run<W: Write>(request: &Request, out: W) -> io::Result<()> {
    let mut out = Emitter::new(out);
    let folder_rooted: Vec<&TypeSpec> =
        request.specs.iter().filter(|spec| spec.walks_root(contract::ROOT_KIND_FOLDER)).collect();
    for root in &request.roots {
        let rooted: Vec<&TypeSpec> = request.specs.iter().filter(|spec| spec.walks_root(&root.kind)).collect();
        scan_into(&mut out, &rooted, &root.path, &root.kind, None)?;
        let mut failure: Option<io::Error> = None;
        walk::walk(&root.path, &request.policy, &mut |visit| {
            if failure.is_some() {
                return;
            }
            let mut write = || -> io::Result<()> {
                out.walk_entry(
                    visit.dir,
                    walk::names(visit, visit.subdirs),
                    walk::names(visit, visit.files),
                    visit.listing.error.as_ref(),
                )?;
                scan_into(&mut out, &folder_rooted, visit.dir, contract::ROOT_KIND_FOLDER, Some(visit.listing))
            };
            failure = write().err();
        });
        if let Some(error) = failure {
            return Err(error);
        }
    }
    out.finish()
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--contract-version") => {
            println!("{}", contract::CONTRACT_VERSION);
            return ExitCode::SUCCESS;
        }
        Some(other) => {
            eprintln!("flowpad-diskio-scan: unknown argument {other:?}; usage: flowpad-diskio-scan [--contract-version] < request.json");
            return ExitCode::from(2);
        }
        None => {}
    }
    let mut raw = String::new();
    if let Err(error) = io::stdin().read_to_string(&mut raw) {
        eprintln!("flowpad-diskio-scan: cannot read the request: {error}");
        return ExitCode::from(2);
    }
    let request = match request::parse(&raw) {
        Ok(request) => request,
        Err(message) => {
            eprintln!("flowpad-diskio-scan: bad request: {message}");
            return ExitCode::from(2);
        }
    };
    let stdout = io::stdout();
    match run(&request, BufWriter::with_capacity(1 << 16, stdout.lock())) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("flowpad-diskio-scan: cannot write the stream: {error}");
            ExitCode::from(1)
        }
    }
}

#[cfg(test)]
mod tests;
