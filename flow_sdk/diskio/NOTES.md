# diskio — implementation notes

Spec: `docs/data-management/diskio.md`. This file records where the code here
departs from it, what each Python backend shares with the existing read path,
and what is left for later steps.

## State

- **In production:** the `Scanner` piece. `stage1.stage1_items` is called by
  `fs_store/indexer/walk.py::gitignore_walk` (a specs-less request is a tree walk)
  and by `project_folder_walker_fn` (walk + per-folder declared scans); it answers
  None whenever Python would do the work, and the in-process walk runs as before.
- **Rust backend:** `Scanner` only — `rust/scan.py` over the `flowpad-diskio-scan`
  binary. Completeness of any backend's stream is checked in ONE place,
  `stage1._collect`; a failed stream re-runs that call on Python.
- **Declared and tested, not yet called by production:** `DocumentReader`,
  `TextExtractor`, `Prober`, `ShadowStore`, `SessionReader`, `TreeHasher` (and
  `TreeWalker` / `DeclaredScanner` as pieces of their own). Their Python backends
  wrap today's functions; the existing entry points do not go through `kernel()`.
  Each is flipped when it gets a second backend. Until then the conformance kit
  is what keeps the contract honest.

## What each Python backend shares

| piece | shares | new code here |
|---|---|---|
| TreeWalker | `fs_store/indexer/walk.py::walk_entries` — the descent, extracted from `gitignore_walk`, which is now a view of it; `fs_store/gitignore.py::stack_ignores` — step 4 of `is_ignored`, extracted | the policy-to-skip adapter, `walk_policy()` |
| DeclaredScanner | `assets/scanning.py::scan_declared`, called with a `TypeScanSpec` wearing the few `TypeInfo` attributes it reads | `type_scan_spec(info)`, the exporter |
| Scanner | the two backends above | the composition and its stream order |
| DocumentReader | `assets/document.py::read_document_bytes` | exception-to-`ItemError` mapping |
| TextExtractor | `wiki/parser.py::parse_links`, `llm_index/markdown_document.py::extract_wiki_links` and `_H1_RE` | none |
| Prober | `fs_record.py::_digest`, `_HASH_GLOB`, `_METADATA_JSON` | the fingerprint rules and the sentinel decision as data-in functions |
| ShadowStore | `record_paths.py::is_record_dir`; the Prober's functions | enumeration with the records root passed in |
| SessionReader | `_parse_jsonl_stats`, `_parse_codex_jsonl_stats` | exception-to-`ItemError` mapping |
| TreeHasher | `llm_index/core.py::fold_tree` — the hashing half of `scan_tree`, extracted; the TreeWalker's walk | the post-order flattening |

Three existing modules were edited, each a pure extraction with no behavior
change: `fs_store/indexer/walk.py`, `fs_store/gitignore.py`, `llm_index/core.py`.
The indexer imports `flow_sdk.diskio` only inside functions, so there is no import cycle.

## Deviations from the spec — the code won

0. **The value classes live in `flow_sdk/schema/data_spec/diskio_spec.py`**, not
   in `contract.py`, which re-exports them and holds the Protocols. The gate
   `tests/unit/test_data_spec/test_the_two_classification_tables.py::
   test_no_package_outside_this_list_declares_a_shape` refuses a `DataSpec`
   subclass in a package outside its hand-written `SHAPE_PACKAGES`, and
   `flow_sdk.diskio` is not in it. `CONTRACT_VERSION` sits beside the field
   lists it versions. Moving the classes back is one line added to that list.

1. **No `File.names`.** `ShapeSpec` keeps the spec's field list; a fixed-name
   file shape has no scan spec and `type_scan_spec` refuses one. No walked type
   declares one today.
2. **`WalkSpec.mounts` is filled on EVERY walk, `anywhere` ones included**
   (`walk.mounts or placement`). An `anywhere` walk never scans its mounts; they
   are what it skips an entry for being under, and the skip reads the union of
   the type's walk mounts. That union equals `TypeInfo.scan_mounts` for every
   type with an `anywhere` walk (skill, spreadsheet). The Rust binary reads the
   same convention.
3. **`ShapeSpec.ext` and `ShapeSpec.main` default to `None`.** A bare folder
   asset (`Folder(main=None)`) is legal in the code.
4. **`WalkEntry.subdirs` / `files` are NAMES**, not paths. The spec's text
   implies it; it is stated here because `gitignore_walk` yields paths.
5. **`WalkPolicy.file_exts` matches on the suffix** (`PurePath(name).suffix`),
   so a dotfile named `.md` is not an `.md` file. This is `scan_tree`'s rule.
   `glob("*.md")` does match that file, which matters when
   `markdown_in_folder_fn` moves onto `WalkEntry.files`.
6. **A `![[x]]` embed IS a link occurrence** (`parse_links` counts it) and is
   NOT a wiki word (`extract_wiki_links` excludes it). Both are kept.
7. **`DocumentRead.fields` / `ShadowRecord.fields` are typed `dict[str, Any]`.**

## Spec rules the Python backend does NOT implement yet

Each is a behavior change the spec lists in §14, deferred because steps 1-2
change no behavior. The conformance kit pins today's behavior for each.

- **Unparseable `.gitignore` line.** Spec: the line is dropped. Today
  `GitIgnoreSpec.from_lines` raises `GitIgnorePatternError` and the walk
  aborts. The backend shares the walk, so it raises too. The fix belongs in
  `push_gitignore` / `load_gitignore_stack`.
- **`DocumentRead.fields` is not JSON-shaped.** It is what `yaml.SafeLoader`
  returns: a date is a `datetime.date`. No `CSafeLoader`, no timestamp-as-text.
  Only the `yaml11` profile is accepted; the other two raise `ValueError`.
- **`LinkGrammar` fields are not honored.** `extract_text` accepts the default
  Grammar v1 only and raises `ValueError` for any other value.
- **SessionReader keeps no partial stats.** Invalid UTF-8, a line that is JSON
  but not an object, or a field of the wrong type make the existing fold raise.
  The backend answers a zeroed value with `error.kind="decode"`. A non-finite
  number is not treated as a malformed line. `unreadable` is detected by
  re-opening a file whose fold aggregated nothing.
- **`_parse_jsonl_stats` still computes `task_path` and the cost**; the backend
  drops both keys. `model_dump()` of a stats value holds tuples where the
  cached dict holds lists (`tools_used`, `models_used`).
- **TreeHasher folds the whole tree, then streams it.** Order and values are
  `scan_tree`'s; it is not incremental. When two files in one directory both
  qualify as the folder note, only the last is in the stream.
- **`DeclaredScanner.scan` does not stat-check `WalkSpec.mounts` as RESOLVED
  paths.** Mounts are root-relative, as `Walk.mounts` is.

## Choices the spec leaves to the backend

- **Sentinel pick:** the lexically greatest `*.hash`, as §6 and §14 specify.
  `FSRecord._hash_file` still takes filesystem order. They agree whenever a
  shadow dir holds one sentinel, which is the contract.
- **`FingerprintRule.trees` are walked with `walk_entries`** (nothing skipped),
  not `rglob("*")`: `test_recursive_walk_fence.py` allows no raw recursive walk
  in a new module. One difference from the per-type functions: a SYMLINKED
  directory inside a tree is not stat'ed and not entered. Check it before a
  `trees` rule is exported for dataset or deck_template.
- **`FingerprintRule.version=2`** is implemented as plain integers
  (`Σ mtime_ns+size`, `max st_mtime_ns`). Nothing produces a v2 rule yet.
- **`PyProber.probe` raises `ValueError`** for a request with no rule and no
  fingerprint. The spec makes that a wrapper precondition; there is no wrapper yet.
- **`ShadowStore.pending` answers for the types in `rules`.** A type whose
  fingerprint no rule expresses is not in the answer.
- **Scanner stream order:** per root, the root-kind scan lines FIRST, then the
  walk with each directory's folder-rooted lines after its entry; within a scan,
  per type in spec order, candidates then problems. Its `StreamEnd.counts` names
  all three kinds, zero included. Agreed with the Rust binary.
- **PyScanner swallows an `OSError` out of one `(directory, type)` scan.**
  `scan_declared` raises `PermissionError` when it stats `<dir>/<main>` under a
  mode-000 directory the walk yielded; alone, `PyDeclaredScanner.scan` still
  raises, as `scan_declared` does. In the stream that type reads as absent for
  that directory and the scan goes on, which is what the Rust binary does.
  `layout_walker` in production still raises on the same tree.
- **`select.kernel` reads the env and the preference on every call** and keeps
  one instance per piece and backend. The fail-open warning is logged once per
  process, whichever piece trips it.

## Not built

- No `FingerprintRule` exporter from `TypeInfo.asset_hash_fn`: the per-type
  freshness functions in `assets/types/` are still the production source, and the
  Prober's declared rules can differ from them in corner cases (a symlinked
  directory inside a `trees` rule; `globs` matching directories). Declaring the
  rule on each `TypeInfo` and evaluating it in one place is the fix.
- `Prober` / `ShadowStore` re-implement the freshness decision of
  `fs_store/fs_record.py` instead of sharing it; the sentinel pick differs when a
  folder holds two (`FSRecord` takes the first, the Prober the greatest name).
- `threads` is accepted by every method and honoured by none.
- No `tests/long_tests/diskio/` perf cases.
- The migration `migration_2026_10_shadow_dir_rename` is not wired into a release
  recipe slot.
