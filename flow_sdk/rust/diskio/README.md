# flowpad_diskio — the stage-1 scan child

One binary, `flowpad-diskio-scan`: the Rust backend of the `Scanner` piece of
[`docs/data-management/diskio.md`](../../../docs/data-management/diskio.md) (§13).
It takes one `ScanRequest` on stdin, walks each root (§1 TreeWalker), runs the
declared scan (§3 DeclaredScanner) for the root and for every directory the walk
yields, and writes the result to stdout as tagged NDJSON ending in one
`diskio.stream_end`.

It reads directories and nothing else: no registry, no settings, no database, no
ids. Everything it needs from `SchemaRegistry` arrives in the request as data.

This is a crate of its own, not part of the keychain crate in `../` (`flow_rs`):
that crate's signing identity is bound to a keychain ACL.

```bash
cargo build --release          # target/release/flowpad-diskio-scan
cargo test                     # the decision order of the walk, the envelope, the .gitignore port
```

## Command line

| invocation | stdout | exit |
|---|---|---|
| `flowpad-diskio-scan --contract-version` | the contract version as an integer and a newline (`1`) | 0 |
| `flowpad-diskio-scan < request.json` | the stream | 0 |
| a request that is not JSON, lacks a field, or has a field of the wrong type | nothing | 2, the reason on stderr |
| any other argument | nothing | 2 |
| stdout cannot be written | a partial stream with no terminal line | 1 |

stderr carries logs only (a dropped `.gitignore` line, a refused request).
The binary writes no progress lines.

## The request

Field names are the constants of [`src/contract.rs`](src/contract.rs) and mirror
`flow_sdk/diskio/contract.py`. A `spec_kind` key on any object is accepted and
ignored; any other unknown key is ignored too.

| object | field | type | meaning |
|---|---|---|---|
| `ScanRequest` | `roots` | list of `ScanRoot` | walked in this order |
| | `policy` | `WalkPolicy` | one policy for every root |
| | `specs` | list of `TypeScanSpec` | in the order their lines are written |
| | `threads` | int, optional (1) | accepted and ignored: the walk is single-threaded |
| `ScanRoot` | `path` | string | walked as given, after `PurePosixPath` normalisation (`//`, `/./`, trailing `/`); the parent sends it RESOLVED |
| | `kind` | string | the root type handed to the declared scan (`real_project_cwd`, `user_home_folder`, `cwd_root`, `system_root`) |
| `WalkPolicy` | `gitignore` | bool | read the `.gitignore` stack |
| | `file_exts` | list of strings, or `null` | `null` = every file, `[]` = no files, else the files whose `PurePath.suffix`, lowercased, is in the list |
| | `deny_basenames` | list of strings | an entry with one of these names is dropped, file or directory |
| | `skip_segments` | list of `[a, b]` | a path holding `a` then `b` as consecutive segments is dropped |
| | `force_include` | list of strings | read only when `gitignore`: a path with such a segment, from the root's own name down, is never tested against `.gitignore` |
| `TypeScanSpec` | `type_name` | string | |
| | `shape` | `ShapeSpec` | |
| | `walks` | list of `WalkSpec` | |
| `ShapeSpec` | `kind` | `"file"` or `"folder"` | |
| | `ext` | string, required for `file` | the extension a file must have, and the suffix a recursive mount is globbed with |
| | `also` | list of strings, optional | further extensions a `file` shape accepts |
| | `main` | string or `null` | the main document of a `folder` shape |
| `WalkSpec` | `roots` | list of strings | the root kinds this walk hangs on; `"folder"` makes it run for every `walk_entry` |
| | `mounts` | list of strings | root-relative directories, placement already applied; a `*` segment is a glob |
| | `recursive` | bool, optional (false) | |
| | `anywhere` | bool, optional (false) | scan the root itself instead of its mounts |

`WalkSpec.mounts` must be filled on EVERY walk, `anywhere` ones included
(`walk.mounts or placement.scan_mounts(...)`). An `anywhere` walk never scans its
mounts; the union of all of a type's walk mounts is what an `anywhere` entry is
skipped for being under.

A path in the request may hold `\udcXX` escapes (what `json.dumps` writes, with
its default `ensure_ascii`, for a surrogate-escaped name). They are read back as
the raw bytes.

## The stream

One JSON object per line, UTF-8, `\n`-terminated. `spec_kind` is always the
first key. Flushed at least every 256 lines and at the end.

| `spec_kind` | field | type | value |
|---|---|---|---|
| `diskio.walk_entry` | `dir` | string | the directory's path: the root as normalised, or `<parent dir>/<name>` |
| | `subdirs` | list of strings | NAMES of the sub-directories the walk enters, sorted as Python sorts `str` |
| | `files` | list of strings | NAMES of the surviving files, sorted; `[]` when `file_exts` is `[]` |
| | `error` | `null` or object | set when the directory could not be listed; both lists are then `[]` |
| | `error.path` | string | the same as `dir` |
| | `error.kind` | string | always `"unreadable"` |
| | `error.detail` | string | the errno NAME (`EACCES`, `EPERM`, `ENOENT`, …); `OSError` for one the table does not name |
| `diskio.scan_candidate` | `path` | string | the asset root |
| | `type_name` | string | |
| | `layout` | string | `"file"`, `"folder"` or `"main_file"` |
| | `parent` | string | the root or directory it was scanned under — equal to a `walk_entry.dir` |
| `diskio.scan_problem` | `path` | string | |
| | `type_name` | string | |
| | `message` | string | one of the two templates below |
| `diskio.stream_end` | `counts` | object | `{"diskio.walk_entry": n, "diskio.scan_candidate": n, "diskio.scan_problem": n}` — always all three, zero included |

`error` carries no `spec_kind`: it is a plain field of `WalkEntry`, not a tagged value.

**Order.** For each root, in request order:

1. the root's own declared scan — `scan(root.path, root.kind, specs)`;
2. the walk in pre-order, each `walk_entry` followed at once by the folder-rooted
   declared scan of that directory — `scan(entry.dir, "folder", specs whose walks name "folder")`.

One scan writes per type in spec order, a type's candidates before its problems.
A line of step 1 and a line of step 2 can both carry `parent == root`; coming
before or after the root's `walk_entry` is what tells them apart. A root that is
not a directory writes nothing for the walk.

The last line is the one `diskio.stream_end`. A reader refuses a stream that
lacks it or whose counts disagree with the lines it received.

**Problem messages.**

| when | `message` |
|---|---|
| a mount's own stat fails (its parent is unreadable) | `[Errno <n>] <strerror>: '<path>'`, as Python's `str(OSError)` writes it, the path in `repr()` form |
| a non-recursive folder mount holds a non-dot directory without the main document | `directory in <mount name>/ without <main>` |

A mount that cannot be LISTED is silently empty: no candidates, no problem.

**Names that are not UTF-8.** A byte that is not UTF-8 is written as the escape
`\udcXX`, which `json.loads` turns into the surrogate `os.fsencode` maps back to
that byte. Control characters and U+0085, U+2028, U+2029 are written as `\uXXXX`
escapes; every other character is written as itself.

## What matches Python, and where it stops

The oracle is today's Python: `gitignore_walk` for the walk, `scan_declared` for
the scan, and the Python `Scanner` (`flow_sdk/diskio/python/scanner.py`) for the
stream. The parity rig is `bench/rust_scan/` (untracked).

* **`.gitignore` matching is a port of `pathspec.GitIgnoreSpec` 1.1**, not a
  general gitignore library, because the walk's answers are pathspec's:
  `build/**` drops the directory `build` itself, and `*` then `!keep/` does not
  re-include `keep`. `src/gitignore.rs` follows `GitIgnoreSpecPattern` and
  `SimpleGiBackend` line for line. If the SDK moves to another pathspec major
  version, re-run the parity rig.
* **An unparseable `.gitignore` line is dropped** and the rest of the file
  applies (§1 step 0). A reversed range such as `[z-a]` is dropped too. Today's
  Python raises on such a line and aborts the root.
* **A stat that fails** anywhere but on a mount's own path reads as "not a file"
  / "not a directory" and the scan goes on.
* **`threads` is ignored.** One thread, in contract order.
* **Windows** compiles from the same source but is untested: paths go through a
  lossy UTF-8 conversion there, and `[WinError n]` messages are best effort.
* **`repr()` of a path** inside a problem message is exact for printable text,
  quotes, backslashes and non-UTF-8 bytes, and approximate for other
  non-printable Unicode.

## Layout

| file | holds |
|---|---|
| `src/contract.rs` | every tag and field name, and `CONTRACT_VERSION` |
| `src/main.rs` | the command line and the composition: root scan, walk, per-directory scan |
| `src/request.rs` | the `ScanRequest` reader |
| `src/emit.rs` | the NDJSON line writer and the terminal counts |
| `src/walk.rs` | TreeWalker: the decision order per entry |
| `src/gitignore.rs` | one `.gitignore` file as a matcher (the pathspec port) |
| `src/scan.rs` | DeclaredScanner: `scan_declared`, `directory_candidates`, `first_seen` |
| `src/pycompat.rs` | Python's string and path behaviour: sort order, `suffix`, `repr`, surrogate escapes, errno names |
| `src/tests.rs` | the decision order and the envelope, on trees built in a temp dir |

`Cargo.lock` is ignored by `../.gitignore`, as the keychain crate's is.
