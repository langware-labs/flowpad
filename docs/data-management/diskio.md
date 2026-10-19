---
id: 0ba6ce82-57e4-5bc5-bd93-a8060d2ea115
---
# Interface proposal — v6 — FINAL (iteration 6)

**How to read this document.** It specifies the disk-I/O kernel of the Python SDK: eight
*pieces*, each a `Protocol` with one job (§1 TreeWalker, §3 DeclaredScanner, §4 DocumentReader,
§5 TextExtractor, §6 Prober, §7 ShadowStore, §8 SessionReader, §9 TreeHasher) plus §13 Scanner,
the one stage-1 entry that composes §1 and §3. Every piece has a Python backend (v1, §14 says
what it does differently from today) and may have a Rust backend reached in-process (pyo3) or,
for §13 only, as a child process over NDJSON; `kernel(piece)` picks the backend. The rules every
piece obeys — value shapes, path encoding, the RESOLVED path, streaming and completeness, the
transport envelope, backend selection and the contract-version pin, the conformance kit, naming —
are written ONCE in §0 and never repeated per piece; a section that seems to lack a rule is
governed by §0. §2, §10, §11, §12 are notes on pieces that stay Python. §13 holds the hierarchy,
the stage-1 child, its shipping path and the wiring into the existing `ScanMode` switch. §14 is
the Python-backend change list. **§15 holds the five decisions reserved for the USER**, each with
its options and consequences; nothing in the document presumes an answer. **§16 is the written
exclusion of every file-I/O function this proposal does NOT cover**, by theme, with the condition
under which each would re-enter. Every `file:line` is a pointer into
this repository at its compatibility baseline commit, the compatibility
baseline (`00_goal.md`). The version log at the end is history; an implementer can skip it.

Working name for the package: `flow_sdk/diskio/` (OPEN DECISION 3; `docs/glossary.md` reserves
`Flow`, `Graph`, `Workflow`, `Agent`; `Index`, `Store` are overloaded; `diskio`, `kernel` are
unused there). Every value class name below was checked against the glossary and against the
repo's existing nouns (§0 "Naming").

Method of v1 (kept): every value class was derived from the fields its callers actually read
(the caller lists are in each section). Method of v2 (kept): every edge the benchmarks flagged is
DECIDED for both backends and every cross-cutting rule is written ONCE in §0. Method of v3: a
piece earns a Protocol only where a benchmark shows a gain at the call shape the SDK uses; the
rest (§2, §10, §11, §12) are notes that point at the §14 rows holding their measured wins, and
every field without a reader is gone. Method of v4 (kept): every file-I/O owning function in
`flow_sdk/` is either inside a piece or excluded in writing with a reason and a re-entry
condition (§0 Scope, §16); every performance claim names the benchmark row AND the SDK call
shape it was measured at, or says "unmeasured". Method of v5 (kept): every stream ends with the
same terminal on both transports and every pin names the conformance case that checks it (§0
Completeness, §0 Conformance). Method of v6: every Rust artefact has a stated shipping and
loading path and a version pin to the Python contract (§0 Selector, §13 "Where the binary comes
from", §15.4), and every noun was re-checked against the repo for collisions (§0 Naming).

## Decisions taken (2026-10-10) — these override §15 and any text below that still lists them as open

1. **YAML scalars:** `yaml11` — PyYAML semantics stay; the Python backend uses `yaml.CSafeLoader`.
2. **Fingerprint v2:** approved — integer tokens; one full re-index of folder-type records.
3. **Package name:** `flow_sdk/diskio/`.
4. **Rust packaging:** ONE binary (`flowpad-diskio-scan`), vendored and signed exactly like `flow-rs`
   (`flow_sdk/rust/bin/<platform>/`). No pyo3 extension for now; every piece other than the stage-1
   scan is Python-only until a later decision. Linux stays on Python.
5. **Legacy shadow dirs:** renamed once by a migration.
6. **One switch:** `FLOWPAD_DISKIO_BACKEND=rust|python` (default `python`), mirrored by the preference
   `advanced.diskio_backend`. The scan mode FOLLOWS it (no separate `ScanMode.TWO_STAGE` setting), and
   `indexer_backend` / `FLOWPAD_INDEXER_BACKEND` / `FLOWPAD_RS_INDEXER_BIN` / `RSIndexerAdapter` are removed.

## 0. Rules every piece obeys

### Scope

The coverage audit (`07_io_coverage.md`) found 1,451 file-I/O owning functions in `flow_sdk/`
(1,539 modules, `system_projects/**` and tests excluded). This proposal places every one of them:

| disposition | owning functions | where |
|---|---|---|
| **covered** by a piece — §1 TreeWalker, §3 DeclaredScanner, §4 DocumentReader, §5 TextExtractor, §6 Prober, §7 ShadowStore, §8 SessionReader, §9 TreeHasher (and §13 Scanner, which composes §1 + §3) | 54 | the "Replaces" line of each section |
| **excluded by rule** — the DB/FTS layer's file sidecars (`00_goal.md` out of scope) | 22 | the audit's table, once |
| **excluded by rule** — stat-only single-path predicates (`exists` / `is_file` / `is_dir` / `resolve` / `stat`) | 552 | §10 (a note): "call it less", every site single-path |
| **excluded by rule** — spawn-only modules (a subprocess, no file I/O of their own; ~20 shell to git) | 122 | §11 (a note) and §16 T14 |
| **excluded with a reason** — the substantive uncovered functions, by theme T1–T14 | 701 (the audit's count; its per-theme rows sum to 698, the remainder being functions it discusses outside the theme table) | §16, one paragraph per theme with the condition under which it re-enters |

The eight pieces are the heavy READ paths of the scan and index phases — discovery (§1, §3,
§13), per-record parse (§4, §5), freshness and the shadow store (§6, §7), session statistics
(§8) and the Merkle doc tree (§9) — and the batch primitives they share. Nothing that WRITES
is a piece (§16 T3/T5/T6), nothing on a request-sized path is (§16 T7, T13), and no streaming
reader is (§16 T1): each is excluded for a stated reason, not deferred. §0's rules are written
so a piece added later under a re-entry condition obeys them unchanged.

### Values

- A value crossing the boundary is a frozen `DataSpec` (`flow_sdk/schema/data_spec/spec.py`:
  frozen, `extra="forbid"`) registered with a `spec_kind` (`diskio.<name>`), **or** a `list` /
  `dict` whose leaves are JSON primitives (`str`, `int`, `float` (finite), `bool`, `None`) or such
  values. Never a `set`, never `bytes`, never a `tuple`-as-record, no `datetime`, no `Path`, no
  non-finite float. The same object travels over pyo3 and over the NDJSON pipe; a Python backend
  post-processes anything PyYAML, `json.loads` or `fromtimestamp` produces into that shape BEFORE
  building the value (§4 and §8 say exactly how).
- `flow_sdk/diskio/contract.py` is imported from `register_builtin_kinds()`
  (`flow_sdk/schema/data_spec/_kinds.py`); an unreachable kind resolves to `Any` silently. A
  conformance test asserts every `diskio.*` kind resolves to its class. The same module declares
  `CONTRACT_VERSION` (§0 Selector); bumping it is part of ANY change to a `diskio.*` field list —
  a field added, removed, renamed or retyped — because a Rust artefact built for the old list
  would otherwise fail `model_validate` on every item, forever, with no single line saying why.
- Inputs are batches of `str` paths plus `*Spec` / `*Rule` / `*Policy` values — plus, for the two
  in-memory methods, the content itself (`bytes` for `read_bytes`, `str` for `extract_text`).
  Never `Path`, never `FSRef`, never a registry object. Anything a piece needs from
  `SchemaRegistry`, `TypeInfo` or settings is exported once per run as data and passed in.
- The kernel never calls back into Python, never reads the DB, never mints or stamps an id,
  never writes Python state. Identity is read by Python from the `fields` the kernel returns.
- Per-item failures are `ItemError` values on the result, never exceptions that abort the
  batch. The wrapper decides which `ItemError` kinds re-raise (§4 lists them). A value whose
  own `path` is `""` (a `read_bytes` document) carries an error whose `path` is `""`. Each
  `error` field below names the kinds its piece produces; a backend produces no others.

### Encoding

- A path crosses as the `os.fsdecode` form of its bytes (surrogate-escaped `str` for a name
  that is not valid UTF-8). Over pyo3 a backend extracts path INPUTS as `PathBuf` (fs-encoded,
  surrogateescape-safe) and returns path OUTPUTS through `PyUnicode_DecodeFSDefault`. Over
  NDJSON a lone surrogate is written as a `\udcXX` escape by the line writer — the one place a
  Rust backend does not use `serde_json`'s default string writer — and Python's `json.loads`
  accepts it. Nothing is dropped for its name; `gitignore_walk` yields such entries today
  (`walk.py:76-100`).
- File CONTENT a piece interprets as text has its own rule in its section (§1: U+FFFD
  replacement; §4: strict → `error.kind="decode"`; §8: strict → `error.kind="decode"` with partial
  stats; §9 titles: U+FFFD replacement).
- The conformance kit holds one non-UTF-8 filename per path-taking piece.

### RESOLVED path (definition used by §6, §7, §13, §14)

"RESOLVED" means Python `Path.resolve(strict=False)` semantics: non-strict realpath (a dangling
tail is kept unresolved), symlinks followed component by component, **no** NFC normalisation,
**no** posix conversion. `FSRef.__init__` stores it (`fs_ref/base.py:42`) and the path digest
hashes it. It is distinct from `path_utils.canonical_posix_path` (realpath + NFC + posix), which
stays Python (§10).

### Streaming

- Batch in, iterator out; results stream as produced. Every kernel call is synchronous and the
  callers already run it under `asyncio.to_thread` (`FSIndexer.scan` chunks of
  `_SCAN_CHUNK_NODES=256`, `_probe_chunk`, `from_disk_fn`).
- **pyo3:** the backend runs the batch on its worker pool (below), capped by the method's
  `threads` argument (1 = sequential), hands finished items through a bounded channel, and
  releases the GIL while `__next__` blocks on that channel. Each item arrives as a JSON-shaped
  dict; the Python side builds the value with `model_validate` (`Probe` 0.66 µs, a 25-name
  `WalkEntry` 0.95 µs, re-measured in review 4 — not a bottleneck against bench 6's 88 ms for
  5,000 probes; `model_construct` is no faster, and a backend does not reach for it).
- **Thread budget.** Each backend owns ONE process-wide pool: Rust the global rayon pool, sized
  once at import; Python one `ThreadPoolExecutor`. Its size is `min(os.cpu_count(), N)`, set
  once by the server from a preference (the key is an implementation choice) and never widened
  to clear a symptom (the CLAUDE.md timeout rule applies to pool sizes too). A call's `threads`
  is a CAP within that pool — never a request for new threads — so concurrent `pending`
  requests, an index run and a session-stats batch share one budget instead of each asking for
  a machine. The stage-1 child receives `ScanRequest.threads` and caps its own pool the same
  way. A `threads` value is a cap the backend MAY ignore: a Python backend that cannot
  parallelise a method says so in §14 (SessionReader and ShadowStore are sequential there). The
  parallel numbers in `02_benchmarks.md` were measured one unit at a time with 14 threads on a
  14-core box and say nothing about two pieces running at once.
- **NDJSON:** the producer writes one envelope line per value (§0 "Transport") and flushes at
  least every 256 items and at batch end; the terminal `StreamEnd` line is flushed last.
- **Completeness.** Every iterator a backend returns — over pyo3 or from the child — yields its
  items and then exactly ONE `StreamEnd(counts)` as its LAST item; the eight iterator signatures
  below say so (`Iterator[… | StreamEnd]`). A pyo3 producer that stops without yielding it (a
  worker panicked and dropped the channel sender, a `PanicException`, any exception) makes
  `__next__` raise — a closed channel is never end-of-stream. ONE consumer code path in the
  wrapper layer, shared by both transports, strips the terminal and verifies it: an exception, a
  missing `StreamEnd`, a count that disagrees with the items received, or — for the key-joined
  pieces §4, §6, §8 — an input key with no item is STREAM FAILURE. On stream failure the wrapper
  re-runs THAT call on the Python backend (§13: the `ScanMode.THREAD` scan); `§7 records` raises
  (its wrapper has no in-process twin to re-run). A missing key is never read as "fresh",
  "absent" or "no document", and a partial set never reaches stage 2 or the orphan sweep — the
  rule `subprocess_scan.py:160-171` applies today to the candidate count, now on both
  transports. Conformance: a backend fixture that stops after N items makes the wrapper fall
  back, on both transports.
- **Order.** Pieces whose output order is part of the contract — §1 TreeWalker (pre-order), §3
  DeclaredScanner (spec order, then `scan_declared` order), §9 TreeHasher (post-order) — may
  parallelise internally but MUST yield in contract order. §4 DocumentReader, §6 Prober, §7
  ShadowStore and §8 SessionReader may yield in any order; every item of theirs carries its key
  (`path` or `record_id`) so the consumer joins by key, never by position.

### Transport — which piece runs where (the shapes are identical on every row that has two)

| piece | pyo3 in-process | NDJSON child |
|---|---|---|
| §13 Scanner (one `ScanRequest` in, the tagged stream out) | yes — the pyo3 module | yes — the stage-1 scan child |
| §1 TreeWalker, §3 DeclaredScanner (the two primitives §13 composes; also called directly by §9 and `scan_declared`) | yes | inside the stage-1 child only |
| §4 DocumentReader, §5 TextExtractor, §6 Prober, §7 ShadowStore, §8 SessionReader, §9 TreeHasher | yes | no — pyo3 is their only transport |

§2, §10, §11, §12 have no Protocol and no row: they stay Python (notes below). §16 lists what
has no piece at all. The two transports that ship — the pyo3 iterator and the stage-1 child's
stream — are the two the conformance kit exercises; a third NDJSON producer written only to be
tested would be a rig (§0 Conformance).

- **NDJSON envelope.** Every value line is the `Tagged` form of `spec.py:446-470`:
  `{"spec_kind": "<diskio.kind>", ...fields}`. The reader pops `spec_kind`, resolves the class
  through the registry (`_by_kind`) and validates the rest as that class — so a stream may
  interleave kinds (§13 mixes `WalkEntry`, `ScanCandidate`, `ScanProblem`; §9 mixes `FileNodeValue`
  and `FolderNodeValue`). A bare `model_dump()` writes no tag and `extra="forbid"` would reject
  an untagged line with a stray key (`spec.py:96`); the envelope is therefore mandatory.
- **Terminal line.** Every NDJSON stream ends with ONE `StreamEnd` whose `counts` map each
  emitted `spec_kind` to the number of lines of that kind — the same value the pyo3 iterator
  yields last (Streaming, Completeness: one rule, one consumer, both transports). The reader
  refuses a stream that lacks it or whose counts disagree with what it received — the rule
  `subprocess_scan.py:160-171` applies today to the candidate count. Absence = failure = fall
  back to Python, never a partial set.
- **Progress lines** keep today's `IndexProgressTable` shape (`ndjson_stream.py:13-15`) and
  carry no `spec_kind`; they are the one legacy, untagged line kind and are recognised by that
  absence.

### Selector

`kernel(piece)` answers the backend class for one Protocol: env `FLOWPAD_DISKIO_BACKEND` >
pref `advanced.diskio_backend` > `"python"`. Rust is fail-open: an import failure logs once and
answers the Python class (same temperament as `vendored_flow_rs_enabled`,
`flow_rs_binary.py:66-80`). A STREAM failure (Streaming, Completeness) is per call: the wrapper
re-runs that one call on the Python class and the selector's answer is unchanged — a data
failure never latches the Rust backend off (§13 "Child adapter" has the one latch that exists,
and it is for spawn failures of a PRESENT binary only).

- **Contract version.** `contract.py` declares `CONTRACT_VERSION: Final[int]` (the block below).
  The pyo3 module exports the same constant (`CONTRACT_VERSION` at module level) and the stage-1
  binary answers `--contract-version` with the integer on stdout. `kernel()` compares at
  SELECTION time — once per process per piece — and treats a mismatch exactly as an import
  failure: log once ("extension built for contract N, this wheel is M"), answer the Python class
  for the rest of the process. Without this pin a stale artefact whose every item fails
  `model_validate` would be a stream failure on every call (Completeness), re-run on Python,
  never latched — double work forever. Conformance: `test_kinds.py` asserts the imported Rust
  module's constant equals the contract's; the kit's `backend` fixture deselects a Rust module
  whose constant disagrees, with the reason "contract version mismatch".
- **Absent on this platform.** For §13, "no stage-1 binary for this platform" is decided BEFORE
  selection by a pure lookup (§13 "Where the binary comes from"); `kernel(Scanner)` then answers
  the pyo3 module if it imports and passes the version check, else the Python `Scanner`. An
  absence is never a spawn, never a latch and never a per-process warning.
- **One switch.** `advanced.diskio_backend` is the ONLY "which implementation" switch after this
  proposal; the live `advanced.indexer_backend` Rust switch is retired (§13 "The switch it
  replaces", §14 row). `auto_index.index_function` (`ScanMode`) stays as the separate "where does
  the walk run" switch.

### Conformance

The kit is what every pin in this document leans on, so it is specified once here.

1. **Where and how.** One module per piece under `tests/unit/diskio/` (`test_walker.py`,
   `test_declared_scanner.py`, `test_document_reader.py`, `test_text_extractor.py`,
   `test_prober.py`, `test_shadow_store.py`, `test_session_reader.py`, `test_tree_hasher.py`,
   `test_scanner.py`), plus one `test_kinds.py` asserting every `diskio.*` kind resolves to its
   class AND that the imported Rust module's `CONTRACT_VERSION` equals `contract.CONTRACT_VERSION`
   (§0 Selector). Every test is parametrised by a `backend` fixture whose values are the Python class
   ALWAYS and the Rust class only when its module imports. The kit instantiates the class
   DIRECTLY — never through `kernel()` — so fail-open cannot turn a Rust-vs-Python comparison into
   Python-vs-Python and pass. When the Rust backend is absent its param is deselected (not
   skipped, not failed) with the reason "Rust backend not built". CI runs both params only once
   it builds the extension: today `.github/workflows/` has no cargo / maturin step, and adding one
   is the packaging route of OPEN DECISION 4 — until it is taken, the Rust leg runs where the
   extension is built locally.
2. **Oracles.** §1 TreeWalker: `git check-ignore --no-index` on the synthetic tree, with the two
   documented divergences (`.claude` force-include, `.flow` denylist) excluded (bench 2's
   three-way check). Every other piece: the Python backend's value, asserted by `==` on the
   `DataSpec` values (same fields, same order where order is contract — §0 Order). §13 Scanner:
   `ScanMode.THREAD` is the oracle (§13 Wiring).
3. **Fixtures.** Synthetic, built in `tmp_path` by the test — never a corpus from a real store or
   checkout (rigs are discarded; nothing under `~/.flow` or `~/Documents` is committed). Named
   cases: the bench-4 23-file YAML edge set (§4, all three profiles); one document per §4
   boundary character (eleven); the §6 (unreadable-at-stamp, unreadable-at-probe) pair and one
   legacy 2-part sentinel; one non-UTF-8 filename per path-taking piece (§0 Encoding); a
   mixed-fence document with a `` ``~ `` fence and an empty `` `` `` span (§5); a type dir of only
   asset-less records and one mixed dir whose only asset-bearing record is fresh (§7); a mode-000
   mount and a mode-000 mount PARENT (§3); a producer fixture that stops after N items (§0
   Completeness, both transports); a child stream with one unknown-kind line (§13); a bare `.md`
   dotfile that is not a source (§9); a `ProbeRequest` with no rule and no fingerprint (§6, the wrapper
   raises); the `project_tree` fixture of `test_subprocess_scan.py` for §13 parity.
4. **Transports under test.** The pyo3 iterator (every piece) and the stage-1 child's stream
   (§13 only) — the two that ship. No piece has an NDJSON producer that exists only for the kit.
5. **Tier.** Two cases are wall-clock-bound and live in `tests/long_tests/diskio/` with the
   measured cost annotated (CLAUDE.md `long` tier): §7 `records(load_meta=True)` over one
   synthetic 9,566-record type, Python vs Rust; the bench shapes (5,000 probes, 1,941 documents).
   Everything else is under 1 s per case or it is a bug in the backend under test.

### Naming

A new noun is checked against `docs/glossary.md` and the repo (`flow_sdk/`, `ts_sdk/src`,
`ui/src`, `agentic-assets/`) before it is used, and the glossary's first rule is applied: say
whether it mirrors a provider or is ours.

**Ours or a mirror.** Every `diskio.*` noun is OURS and names a read of our own on-disk
structures, except `ClaudeSessionStats` and `CodexSessionStats` (§8), which MIRROR the two
vendors' transcript JSONL (glossary "transcript" row, `docs/glossary.md:20,72-81`) and keep the
vendors' key names for that reason; a third vendor adds a third mirror, never a shared base.

**Rejected for collision**, with the holder of the word: `Budget` (the LLM allowance, glossary
l.243/352); `Issue` (`ScanIssue` in `indexer/index_log.py:167`, `AssetScanIssue` in
`assets/scanning.py:31`); `Link` (`WikiLink`, "launch link"); `Walker` (inside the indexer
"walker" is the per-type candidate function — `walkers/generic.py:20-30` `layout_walker`,
`builtin.py:92` "every production walker" — which is §3's job, so §1 is `TreeWalker`; the
alternative `Traverser` was rejected too: `traverse` is the data-driver pull verb,
`ingest/driver_runtime.py:530`); `token` (an LLM token — `input_tokens` in §8, glossary "token
allocation" — or an OAuth token, `token_for`; the repo's word for the freshness value is
`fingerprint`, `fs_ref/base.py:199`, so §6 says `FingerprintRule` / `fingerprint`); `Candidate`
(`llm_source.py:103` `class Candidate(NamedTuple)`, an endpoint plus its funding verdict — §3 is
`ScanCandidate`); `DocumentValue` (`ts_sdk/src/fs/AssetDocument.ts:3`, the JSON LEAF type of
`AssetDocument.fields` — §4 is `DocumentRead`); `STAGED` as a `ScanMode` value (five modules use
STAGED for files staged in git or a bundle, and `setup.stage` / `setup.stage_state` are
registered kinds — §13 is `TWO_STAGE`).

**Checked and in use:** `ScanRequest`, `ScanRoot`, `StreamEnd`, `Scanner` (`notification_scanner.py`
is a module; the UI's "Records Scanner" is the label of the indexer-status screen this piece
feeds — the same thing, not a second one), `TreeWalker` (free; `docs/data-management/
gitignore-walk.md:7` already calls this descent a "tree walker"), `FingerprintRule`,
`ScanCandidate`, `DocumentRead`, `TWO_STAGE` — none exists in the four roots or the glossary. The
23 `spec_kind` tags match `TAG_PATTERN` (`tags/grammar.py:31`); the `diskio` namespace is absent
from the ~250 kinds registered today, and `SchemaRegistry.register_kind`
(`schema_registry.py:1091-1101`) raises on a second shape under one kind, so a tag collision
would be loud. `kind` as a FIELD name (`ItemError.kind`, `FingerprintRule.kind`, `ShapeSpec.kind`,
`ScanRoot.kind`) is explicitly allowed by `spec.py:17-20` (the registration hook is `spec_kind`
so that a user may author a field named `kind`).

```python
# flow_sdk/diskio/contract.py
from typing import Final, Iterator, Literal, Protocol, Sequence, TypeVar

CONTRACT_VERSION: Final[int] = 1   # bumped with ANY diskio.* field-list change (§0 Values);
                                   # the pyo3 module exports the same name, the stage-1 binary
                                   # answers `--contract-version`; kernel() compares (§0 Selector)

class ItemError(DataSpec):
    spec_kind = "diskio.item_error"
    path: str = ""                                          # "" when the value itself has no path (read_bytes)
    kind: Literal["unreadable", "decode", "capsule", "parse"]
    detail: str                                            # errno NAME for unreadable (EACCES, EPERM, ENOENT, …)

class StreamEnd(DataSpec):     # the LAST item of every stream, pyo3 iterator or NDJSON child (§0 Completeness)
    spec_kind = "diskio.stream_end"
    counts: dict[str, int]    # spec_kind → lines emitted of that kind

# flow_sdk/diskio/select.py
P = TypeVar("P")

def kernel(piece: type[P]) -> P:
    """Return the backend instance implementing Protocol ``piece`` (§0 Selector)."""
```

## 1. TreeWalker — the one shared walk (also the stage-1 scan child)

Replaces the inside of `gitignore_walk` (`flow_sdk/fs_store/indexer/walk.py`). Its five
callers keep the `(Path, [Path], [Path])` tuples: `functions/project_folder_walker.py:65`,
`operations/markdown_dirs.py:130`, `llm_index/core.py:153` (via §9), `tags/bindings.py:172`,
`ingest/write_back.py:209` (`gitignore=False, denylist=False`).

**Not** moved onto this piece: `assets/folder.py::AssetFolder.scan` (`folder.py:198-223`). Its
descent prunes on CLASSIFICATION results (a Folder-shaped asset is not descended; `scan_mounts`
runs instead), stops at another project's root (`_is_project_root`, `:63-71`), skips every
dot-entry including `.claude`, and reports an unreadable dir as a scan issue. None of that is
expressible as walk data without re-implementing classification in the kernel. It and the fsop
watcher (§2) are the two single-path callers of the Python matcher primitives
(`push_gitignore` / `is_ignored`); if a per-event benchmark ever earns a matcher piece, those are
its callers, and the parity test (`tests/unit/test_fs_store/test_walker_gitignore_parity.py:26-31`)
stays the guard that both prune the same checkout dirs.

```python
class WalkPolicy(DataSpec):
    spec_kind = "diskio.walk_policy"
    gitignore: bool
    file_exts: tuple[str, ...] | None                      # None = every file; () = no files; else only names
                                                           # with one of these suffixes (case-insensitive)
    deny_basenames: tuple[str, ...]                        # the wrapper fills from gitignore.py (_WALK_IGNORED)
    skip_segments: tuple[tuple[str, str], ...]             # the wrapper fills ((".claude", "worktrees"),)
    force_include: tuple[str, ...]                         # the wrapper fills (".claude",) — applied only when gitignore

class WalkEntry(DataSpec):
    spec_kind = "diskio.walk_entry"
    dir: str
    subdirs: tuple[str, ...]                               # sorted by name, already filtered
    files: tuple[str, ...]                                 # per file_exts; empty when file_exts=()
    error: ItemError | None = None                         # kinds: unreadable (detail = errno name); lists are empty

class TreeWalker(Protocol):
    def walk(self, root: str, policy: WalkPolicy, *, threads: int = 1) -> Iterator[WalkEntry | StreamEnd]: ...
```

The contract carries no copy of a repo constant: the ONE wrapper (`gitignore_walk`) fills the
three lists from `gitignore.py`; §9's wrapper and the §13 parent build their policies the same
way.

**Decision order per entry** (`gitignore.py:128-172`, `walk.py:78-100`; every backend reproduces
it exactly):

0. On descending into a dir, its `.gitignore` (if a regular file) is read as UTF-8 with U+FFFD
   replacement (`gitignore.py:133`); a line pathspec cannot parse (e.g. `a\`, a bare `!`) is
   DROPPED — git's own behaviour — and the file's remaining lines apply. An unreadable
   `.gitignore` contributes nothing. (Today an unparseable line raises `GitIgnorePatternError`,
   a `ValueError` that `push_gitignore` does not catch, and aborts the whole root before it is
   yielded — §14.)
1. Entry type from the readdir cache: a real directory (not a symlink) is a dir; anything else
   must be a file after following symlinks, or it is dropped. A stat error drops the entry.
2. Basename in `deny_basenames` → ignored (files named `build`/`dist` too); any `(a, b)` of
   `skip_segments` appearing as consecutive path segments → ignored. Empty lists make this step
   vacuous.
3. `gitignore=True` only: any ancestor UP TO AND INCLUDING the root whose basename is in
   `force_include` → kept, no further test; else the `.gitignore` stack, outermost → innermost,
   last match wins, a dir tried as `rel/` and as `rel`; a nested file can only ADD ignores (no
   cross-file `!` re-include). (`is_ignored`, `gitignore.py:152-172`: denylist, then
   force-include, then the stack.)
4. A surviving file is listed only if `file_exts` admits it (`None` admits all).

The root is walked AS GIVEN (no `resolve()`) and is always yielded, even when a pattern matches
it. Pre-order DFS; the stack is pushed on descend and popped on backtrack. An unreadable dir
yields with empty lists AND `error` set (kind `unreadable`, `detail` the errno name) — the
FOLDER expander needs `EPERM`/`EACCES` versus anything else to run `mark_denied` (§13). There
is no pruning contract: a consumer that wants a narrower tree re-enters with a narrower root.

**Compatibility.** `gitignore_walk(root, *, gitignore, denylist, include_files)` stays and yields
`(Path, [Path], [Path])` as today, ignoring `error`. `include_files=False` → `file_exts=()`,
`True` → `None`. The flag pair maps to the lists as follows (`walk.py:98-100`: with
`gitignore=True`, `is_ignored` applies the denylist whatever `denylist` says):

| `gitignore` | `denylist` | `deny_basenames` / `skip_segments` | `force_include` |
|---|---|---|---|
| True | any | from `gitignore.py` | `_FORCE_INCLUDE` |
| False | True | from `gitignore.py` | (not applied) |
| False | False | `()` / `()` | (not applied) |

The conformance oracle for the stack rules is `git check-ignore --no-index` run by the kit (not a
production method), with the documented divergences (`.claude` force-include, `.flow` denylist)
excluded — bench 2's three-way check.

## 2. Matcher — unchanged, Python (note)

The fsop watcher (`server/fsop_filters.py:95-149`) keeps `load_gitignore_stack` / `push_gitignore`
/ `is_ignored`: it matches ONE path per filesystem event, and bench 2's 23x is measured at a
50k-path batch — no end-to-end gain is measured at the call shape it uses (goal 4). It inherits
§1's step-0 rule (dropped unparseable lines) through `push_gitignore`, a Python v1 change in
`gitignore.py` (§14 TreeWalker row). Its flat all-descendants stack and 5000-dir cap
(`fsop_filters.py:95-118`) are untouched. The demotion is evidence-complete: the per-event cost
includes a `Path.resolve()` BEFORE either matching layer (`fsop_filters.py:120-123`; bench 11:
lstat-bound, ~46 µs), so a matcher piece could cut at most the ~40 µs match of a ~90 µs event.

## 3. DeclaredScanner — typed candidate discovery (fused into the stage-1 scan child)

Replaces the inside of `assets/scanning.py::scan_declared` — the per-node work: every type with
`TypeInfo.walk` runs it once per root node through `walkers/generic.py:28-29`, and the
folder-rooted specs (`skill_type_info.py:36`, `spreadsheet_type_info.py:37`:
`Walk(roots=("folder",), anywhere=True)`) run it once per FOLDER node, ~1,223 times per repo scan.
Callers and the fields they read: `candidates[].path/type_name/layout` and
`issues[].path/message/type_name`, dedup with `first_seen(seen, path)` (`generic.py:29-35`).

**`scan_repo_tree` — unchanged, Python**, run by stage 2 per root as today (`repo_assets.py:19`,
`project.py:701`, `migration_2026_09_entity_json_mains.py:61`). It runs once per root for
0.6-18 ms (bench 3: Rust e2e 0.1-1.1x, "too small to spawn for") and is the only reader of
`retired_families`, `singleton`, `retired_mains`, `retired_migration`, `retired_files`,
`included` and the cycle guard (`scanning.py:165-220`), none of which therefore crosses the
boundary. Its positional `AssetScanIssue` at `scanning.py:212` is fixed in Python (§14).

Declarations are exported from `SchemaRegistry` once per run as data (bench 3: shape, walks with
RESOLVED mounts).

```python
class ShapeSpec(DataSpec):
    spec_kind = "diskio.shape"
    kind: Literal["file", "folder"]
    ext: str | None                                        # file: ".md"
    main: str | None                                       # folder: "SKILL.md"
    also: tuple[str, ...] = ()

class WalkSpec(DataSpec):
    spec_kind = "diskio.walk_spec"
    roots: tuple[str, ...]                                 # "real_project_cwd", "user_home_folder", "folder", …
    mounts: tuple[str, ...]                                # RESOLVED by the exporter (placement applied)
    recursive: bool = False
    anywhere: bool = False

class TypeScanSpec(DataSpec):
    spec_kind = "diskio.type_scan_spec"
    type_name: str
    shape: ShapeSpec
    walks: tuple[WalkSpec, ...]

class ScanCandidate(DataSpec):
    spec_kind = "diskio.scan_candidate"
    path: str
    type_name: str
    layout: Literal["file", "folder", "main_file"]
    parent: str                                            # the root / dir it was scanned under (scan_declared's
                                                           # parent=root, scanning.py:124); stage 2 joins on WalkEntry.dir

class ScanProblem(DataSpec):
    spec_kind = "diskio.scan_problem"
    path: str
    type_name: str
    message: str                                           # one of the two templates below, verbatim

class DeclaredScanner(Protocol):
    def scan(self, root: str, root_type: str, specs: Sequence[TypeScanSpec]
             ) -> tuple[list[ScanCandidate], list[ScanProblem]]: ...
```

Order and dedup are part of the contract: `scan()` emits per type in spec order, within a type
in `scan_declared`'s order (walks in declaration order, `anywhere` entries then mounts sorted,
`directory_candidates` sorted-by-parts), applying `first_seen` (`scanning.py:88-93`): the dedup
key is `os.path.normcase(str(path))`, or the RESOLVED path when the mount directory is a symlink
(`emit(entry, resolve=directory.is_symlink())`, `:151`). AppleDouble names (`._*`) are skipped
(`:139,154`); an `anywhere` entry already under one of the type's mounts is skipped (`:140`).

**Message templates** (the contract; callers persist and dedup on them —
`walkers/generic.py:33-35` → `ScanIssue.detail`):

| when | `message` |
|---|---|
| the mount's OWN stat fails — `mount.is_dir()` raises because its PARENT is unreadable (`:147-151`) | Python's `str(OSError)` on the running platform: `[Errno <n>] <strerror>: '<path>'` on POSIX, `[WinError <n>] <text>: '<path>'` on Windows |
| non-recursive folder shape, a non-dot sub-dir without the main (`:157-161`) | `directory in {directory.name}/ without {shape.main}` |

A mount whose LISTING fails is silently empty — no `ScanProblem`, no candidates:
`directory_candidates` catches the listing `OSError` itself, logs, and returns `[]`
(`scanning.py:109-116`), so a mode-000 mount yields nothing and the `except OSError` at `:147-151`
is reached only through `is_dir()`. Both backends reproduce that (no §14 row: the behaviour is
kept). Conformance: a mode-000 mount → zero problems; a mode-000 mount parent → one problem whose
`message` equals the Python backend's.

Compatibility: `scan_declared(info, root, root_type)` stays, exports the spec for `info`, calls
the piece, and rebuilds `AssetCandidate` (`traversal_parent=Path(parent)`) and `AssetScanIssue`
(keyword-built). `AssetScanIssue` is already a `DataSpec`; `ScanProblem` is its wire twin with
`path: str`.

## 4. DocumentReader — frontmatter + capsule strip + revision (markdown documents only)

Replaces the inside of `assets/document.py::read_document_bytes`. `read_document` keeps routing
entity documents (JSON mains) to `read_entity_document`, and **JSON mains are excluded from the
kernel** for a reason, not by routing: each is one `json.loads` (C already) of a file of a few
hundred bytes, there is no algorithm to port and no benchmark row; the defect there is the READ
COUNT — `entity_document.py:45-58` (`_read`), `serialization.py:237-262` (`read_main` →
`load_json_dict`), `identity_carrier.py:357-359` (`JsonRoot._load`) and `data_driver.py:38-41`
open the same manifest three to four times per record — and that is the §14 "JSON mains" row
through the same one-read seam as markdown (Compatibility, below; §16 T2). The 15 call sites
and what they read:

| reads | call sites |
|---|---|
| `.fields` only | `fs_ref/base.py:18`, `core/entity/frontmatter_accessor.py:47`, `serialization.py:322`, `versioning.py:77` |
| `.fields` + `.body` | `fs_ref/frontmatter_ref.py:32`, `agentic_process/system_prompt.py:84`, `serialization.py:479`, `versioning.py:66`, `document.py:103-123` (patch), `:165,206` (update) |
| `.raw_text` | `actions/fs/asset_versioning.py:39` |
| whole `AssetDocument` returned to HTTP | `actions/fs/fs_actions.py:871`, `assets/asset.py:131`, `migrations/…entity_json_mains.py:88` |

So the value IS `AssetDocument` (already a `DataSpec`, `document.py:35-41`) plus `path`,
`revision` and `error`. `raw_text` travels: it is what the file holds and the stripped `body`
cannot rebuild it. Its only transport is pyo3 (§0 Transport), where the string is a pointer, so
`raw_text` costs no copy on the per-record batch path. Identity stays in Python: `reconcile`
(`indexer/reconcile.py:47-49`) and the Frontmatter carrier's `_outcome_for`
(`identity_carrier.py:236-249`) need only `fields` and `raw_text`, both of which the value
carries, so one read serves the carrier, the probe's wrapper and `from_disk_fn` (§14).

```python
class DocumentRead(DataSpec):
    spec_kind = "diskio.document_read"
    path: str                                              # "" for read_bytes
    raw_text: str
    body: str                                              # capsule-stripped, as AssetDocument.body
    fields: dict                                           # JSON-shaped under EVERY profile (rules below)
    body_start_line: int
    metadata_error: str | None                             # ValueError / YAMLError text, as today
    revision: str                                          # "sha256:…" of the raw bytes
    error: ItemError | None                                # kinds: unreadable | decode | capsule

class DocumentReader(Protocol):
    def read(self, paths: Sequence[str], profile: Literal["yaml11", "yaml12", "strings"] = "yaml11",
             *, threads: int = 1) -> Iterator[DocumentRead | StreamEnd]: ...                   # profile: OPEN DECISION 1
    def read_bytes(self, data: bytes, profile: Literal["yaml11", "yaml12", "strings"] = "yaml11") -> DocumentRead: ...
```

**Header detection** (`document.py:48-54`): the text is split on Python's `str.splitlines`
boundary set, exactly these ELEVEN (written escaped so the file cannot lose them again):
`\n`, `\r`, `\r\n`, `\v`, `\f`, `\x1c`, `\x1d`, `\x1e`, `\x85`, `\u2028`, `\u2029` —
and a line is the `---` fence when its `str.strip()` (Python's whitespace set) equals
`---`. `body_start_line = len(header.splitlines()) + 1`. An opened, unclosed header is
`metadata_error="Unclosed YAML frontmatter"`. The conformance kit holds one document per
boundary character (eleven documents).

**Keys** (`document.py:57-65`, unconditional in the only loader): every mapping key must be a
string and unique; a non-string key is `metadata_error="Document metadata keys must be strings"`,
a duplicate is `"Duplicate document metadata key"`; a non-mapping header is `"Document
frontmatter must be a mapping"`.

**Error model**, mirrored from `document.py:69-90`: a header or YAML problem becomes
`metadata_error` and parsing continues; a capsule problem that is a `ValueError` also lands in
`metadata_error`; `MalformedCapsuleError` / `DuplicateCapsuleError` (not `ValueError`) and
`UnicodeDecodeError` (the text decode is STRICT) abort the read of THAT file and arrive as
`error.kind = "capsule"` / `"decode"`; an `OSError` on open/read is `"unreadable"`. The wrapper
`read_document_bytes` re-raises `capsule` and `decode` so its callers see exactly today's
exceptions; `read()` callers (the indexer) get them as values.

**`fields` is JSON-shaped under every profile.** The `yaml11` profile is PyYAML's `SafeLoader`
resolver MINUS these constructors, whose scalars are returned as the raw scalar TEXT:
`!!timestamp` (so a date or datetime is its own text, not an `isoformat()` rendering — no
datetime library on either side), `!!binary`, and the non-finite `!!float` forms (`.inf`,
`-.inf`, `.nan`). The collection tags `!!set`, `!!omap`, `!!pairs` are a `metadata_error`
("unsupported YAML tag"). `<<` merge keys are flattened (`flatten_mapping`, `document.py:59`;
Rust emulates). Everything else resolves as PyYAML 1.1 does (`yes/no/on/off` → bool, `012` → 10,
`1_000` → 1000, `1:30` → 90, `1e3` → STRING). No caller tests `isinstance(…, datetime)` on
`fields`; the `DataSpec` consumers (`read_main` → `asset_spec.model_validate`) coerce text
themselves. OPEN DECISION 1 chooses the scalar typing of everything else; the 23-file synthetic
edge set of bench 4 is in the conformance kit for all three profiles.

**Compatibility and the one-read seam.** `read_document_bytes` / `read_document` keep their
signatures and call `read_bytes` / `read` for one path. The batch shape (bench 4: 1,941 files
in one call) is reached by the indexer at its existing batch point: `_probe_chunk`
(`index_function.py:937-973`) calls `DocumentReader.read(paths)` ONCE per chunk for the chunk's
markdown-carrier refs and attaches each `DocumentRead` to its `FSRef` as ONE optional,
TRANSIENT attribute (`ref.document`: set by `_probe_chunk`, never written to `metadata.json`,
never part of `FSRef` equality or the dedup key). The Frontmatter carrier's `read(where)`
(`reconcile.py:47-49`), `read_main` and `read_asset_data` consult `ref.document` before opening
the file, so identity, probe and `from_disk_fn` share one read. `from_disk_fn` keeps its
`Callable[[FSRef, str], list[FSRecord]]` signature (`schema_registry.py:222`; goal 1). The
JSON-main `_read` triple (`raw`, `doc`, `body`) rides the same attribute shape for entity
documents, in Python (§14 "JSON mains").

## 5. TextExtractor — wiki-link occurrences, wiki words, H1

Replaces the inside of `wiki/parser.py::parse_links` and
`llm_index/markdown_document.py::extract_wiki_links`, plus the H1 rule (`_H1_RE`). Callers:
`wiki/__init__.py:51` (`parse_links(body)` on the record's in-memory body, result sorted by
line), `assets/types/markdown.py:41` (`_extract_wiki_links(body)`), `MarkdownDocument.wiki_links`
(`:204`), and §9 (rules 7 and 8 only). **Not replaced:** `MarkdownDocument.from_text` — its
callers need `body`, `frontmatter` (the LENIENT non-YAML parser, `markdown_document.py:44-75`),
`set`/`render`/`save` (`rag/chunking.py:210`, `semantic_lock/copiers.py:36`,
`server/routes/docs_graph.py:113`, `llm_index/core.py:203-206`); it stays Python above the kernel.

```python
class LinkGrammar(DataSpec):
    spec_kind = "diskio.link_grammar"
    version: int = 1
    fence_min_ticks: int = 3                               # a run of ≥N backtick/tilde chars opens; the IDENTICAL run closes; masked first
    mask_inline_code: bool = True                          # `…` single-line, masked second
    wiki_url_prefixes: tuple[str, ...] = ("/dock/assets/wiki/", "/dock/hub/assets/wiki/")
    md_link_skip_schemes: tuple[str, ...] = ("http", "https")

class LinkOccurrence(DataSpec):                            # == WikiLink(raw, line, wiki_ref); the store writes these three
    spec_kind = "diskio.link_occurrence"
    raw: str                                               # inner text of [[…]] / md path / decoded wiki word
    line: int                                              # 1-indexed, in the UNMASKED body
    wiki_ref: str | None = None                            # hub or two-segment dock URL only

class DocText(DataSpec):
    spec_kind = "diskio.doc_text"
    h1: str | None                                         # first "# …" line, stripped; the fallback chain is the caller's
    links: tuple[LinkOccurrence, ...]                      # Grammar v1 order (below)
    wiki_words: tuple[str, ...]                            # extract_wiki_links: target minus alias/anchor/block, embeds excluded, de-duped, in order

class TextExtractor(Protocol):
    def extract_text(self, body: str, grammar: LinkGrammar) -> DocText: ...
```

No `error` field: nothing in a pure-`str` parse can fail, and a field with no producer invites a
backend to invent one. Rules 1-6 are the only ones `grammar` influences; rules 7 and 8 take no
grammar field (that is why §9 needs no `LinkGrammar`).

**Grammar v1** (`parser.py:30-48, 61-63, 109-136`; `markdown_document.py:26-28`; bench 5
reproduced every rule with hand-written scanners, 0 mismatches on 6,420 files):

1. **Mask.** The two regexes ARE the rule (`parser.py:48,61`). Fenced blocks first:
   `(?ms)^([`~]{3,})[^\n]*\n.*?^\1\s*$` — a line starting with ANY run of `fence_min_ticks` or
   more backtick/tilde characters (a mixed run such as `` ``~ `` included) opens, and the block
   closes at the next line that starts with the IDENTICAL literal run followed only by
   whitespace (`\s` is Python's set). Then inline code: `` `[^`\n]+` `` — one or more
   non-backtick, non-newline characters between backticks (an empty `` `` `` is NOT masked).
   Each masked span is replaced by spaces of EQUAL length so offsets and lines survive.
   Conformance: a document with a `` ``~ `` fence and an empty `` `` `` span.
2. **Pass 1 — wiki.** `!?\[\[([^\[\]\n]+)\]\]` over the masked text; `raw` = group 1; both `[[…]]`
   and `![[…]]` count.
3. **Pass 2 — wiki URL.** `\[(?:[^\[\]\n]+)\]\(/dock/(hub/)?assets/wiki/(?P<path>[^)\s#]+)(?:#[^)\s]*)?\)`;
   split `path` on the first `/`; `hub/` present OR two segments → `wiki_ref = unquote(seg0)`,
   `raw = unquote(seg1)` (`""` if no seg1); one segment → `wiki_ref=None`, `raw = unquote(path)`.
4. **Pass 3 — md link.** `\[(?:[^\[\]\n]+)\]\((?P<path>(?!https?://)[^)\s]+\.md(?:#[^)\s]*)?)\)`
   (the negative lookahead resumes at start+1, so a nested `[` inside the text still scans);
   skipped when `path` contains `/dock/assets/wiki/` (already pass 2); `raw` = path as written.
5. **Line.** `line = count("\n" in body[:match.start]) + 1` — `\n` only; a lone `\r` does not
   count.
6. **Order.** Pass 1 occurrences, then pass 2, then pass 3, then a STABLE sort by `line` — so
   within a line the order is wiki, wiki-URL, md REGARDLESS of column.
7. **`wiki_words`** (`extract_wiki_links`, `markdown_document.py:28,138-147`): a SEPARATE scan
   over the UNMASKED body with `(?<!\!)\[\[([^\]]+?)\]\]` (no `!` before; the inner text may
   span lines and hold `[`); the inner text is cut at the first `|`, then first `#`, then first
   `^`, and stripped — it is NOT split on `/` (the docstring says "first path segment"; the code
   keeps the whole target, and the code is the contract); empty targets dropped; de-duped
   preserving first occurrence.
8. **H1.** The first line matching `^#\s+(.+?)\s*$` (multiline; `\s` Python's set) → group 1.

`canonicalize_word` and the resolver stay Python (`wiki/parser.py:72-82`, `wiki/resolver.py`).

Compatibility: `parse_links(body)` builds `WikiLink(raw=, line=, wiki_ref=)` from `links`;
`extract_wiki_links(body)` returns `list(wiki_words)`.

## 6. Prober — the skip-fresh freshness probe

Replaces the per-record `FSRecord(type, id, asset_ref).index_required` walk in `_probe_chunk`
(`index_function.py:937-973`, whose only read of the probe is `not probe.index_required`, `:959`)
and the per-record half of `type_has_pending_changes`. Runs AFTER identity (needs `record_id` to
find the shadow dir).

The fingerprint is `TypeInfo.asset_hash_fn(ref)` stringified, else `FSRef.fingerprint`
(`fs_record.py:590-605`). Fifteen fingerprint functions exist; all are expressible as one grammar:

| rule | types | source |
|---|---|---|
| `stat` → `f"{mtime_ns}:{size}"` of the asset path; `""` when it cannot be stat'ed | every type without `asset_hash_fn` | `FSRef.fingerprint` (`fs_ref/base.py:199-205`) |
| `stat_sum` → `repr(float(Σ (mtime_ns+size)))` over `parts` | entity documents (`[main, body]`), manifest folders (`[".", main]`) | `assets/identity.py:76-106` |
| `max_mtime` → `repr(max st_mtime)` over `parts` ∪ `globs` ∪ `trees`, start `0.0` | trigger, wizard, helpdesk (`[main]`); skill (`SKILL_INNER_FILES`); task (`[task.json, spec.md]`); chart (every direct file: `CHART.md`, `board.json` / `chart.json`, `thumbnail.svg`); spreadsheet (`["."]`); deck (`[deck.json]` + `*.html`); journey (`[graph.json]` + `*.html`); graph_workflow (`[graph.json]` + `scripts/*`); dataset (`[manifest, data.csv]` + tree `examples`); deck_template (`[manifest, media]` + globs `media/*` + trees `layouts`, `common`; `deck_template.py:124-135` stats every direct child of `media/`) | `assets/types/{skill,task,dataset,deck,deck_template,journey,graph_workflow,chart,spreadsheet,trigger,wizard,helpdesk}.py` |

`base` is the asset path when it is a directory, else its parent; `"."` names the asset path
itself; `globs` are one-level patterns under `base`; `trees` are recursive and stat EVERY entry
including directories (`rglob("*")`). A missing part is skipped (`OSError` → continue). When the
function raises, `get_hash` falls back to `fingerprint` — the kernel does the same: an
unevaluable rule degrades to `stat`. A `stat` that fails yields the EMPTY fingerprint, whose digest
never equals a sentinel stamped for a READABLE asset, so `index_required=True`; `error` then
carries kind `unreadable` for information (today: `fingerprint` returns `""`, same outcome). A
sentinel stamped while the asset was unreadable holds `blake2b("")` too (`write_hash`,
`fs_record.py:724-736`, stamps whatever fingerprint was live at commit) and a later empty fingerprint
matches it — `index_required=False`, as today; the pair (unreadable at stamp, unreadable at
probe) is a conformance case so both backends agree on it.

**Float construction and rendering** (version 1; bench 6 needed `py_float_repr`):
`max_mtime` uses CPython's `st_mtime` double — `fill_time`'s `(double)sec + 1e-9 * (double)nsec`
— starting at `0.0` (`skill.py:109-119`); `stat_sum` is `float(int_total)` with round-half-even
on an integer above 2^53 (`identity.py:88-106`). The text is Python `repr(float)`: shortest
digit string that round-trips, exponent form when the decimal exponent is < -4 or ≥ 16
(`3.582678104441483e+18`), `.0` appended to an integral value otherwise. OPEN DECISION 2 is the
integer form (`version=2`).

```python
class FingerprintRule(DataSpec):                                 # one per type, exported from TypeInfo
    spec_kind = "diskio.fingerprint_rule"
    version: int = 1                                       # 1 = today's float-repr form; 2 = integer   (OPEN DECISION 2)
    kind: Literal["stat", "stat_sum", "max_mtime"]
    parts: tuple[str, ...] = ()                            # relative to base; "." = the asset path itself
    globs: tuple[str, ...] = ()                            # one level under base
    trees: tuple[str, ...] = ()                            # recursive, dirs included

class ProbeRequest(DataSpec):
    spec_kind = "diskio.probe_request"
    record_id: str
    type_name: str                                         # the key into `rules` (one lookup per batch, not per record)
    asset_path: str                                        # RESOLVED (§0): FSRef stores it; the path digest hashes it
    shadow_dir: str                                        # <records_root>/<type>/<record_id>/
    fingerprint: str | None = None                               # pre-computed by the wrapper → kernel skips the rule (per-type fail-open)

class Probe(DataSpec):
    spec_kind = "diskio.probe"
    record_id: str
    index_required: bool
    error: ItemError | None                                # kinds: unreadable (the asset path or the shadow dir)

class Prober(Protocol):
    def probe(self, requests: Sequence[ProbeRequest], rules: dict[str, FingerprintRule], *, threads: int = 1
              ) -> Iterator[Probe | StreamEnd]: ...
```

`rules` is exported ONCE per run from the registry (`type_name → FingerprintRule`), the same shape
§7's `pending` takes — one export serves both methods, and the per-record registry lookup of
today's `get_hash` (`fs_record.py:596-599`) disappears from the wrapper. A request whose
`type_name` is absent from `rules` must carry `fingerprint` (that is the per-type fail-open below).
That is a wrapper PRECONDITION, not a backend case: `probe()`'s wrapper raises `ValueError`
BEFORE the call if any request's `type_name` is absent from `rules` and `fingerprint` is `None`; a
backend may assume the invariant and defines nothing for it. (A `stat` fingerprint for a folder type
would never equal the `max_mtime` sentinel `write_hash` stamps, `fs_record.py:729-736`, so a
silent degradation would re-index that record on every run with no error anywhere.) The `stat`
degradation for an UNEVALUABLE rule — missing parts — stays as written above. Conformance: the
wrapper raises on such a request.

**Digests** are internal to the probe: `content_digest = blake2b(digest_size=8)` hex of the
fingerprint, `path_digest` = blake2b-8 hex of `asset_path` (`fs_record.py:654-658`). `write_hash`
(`:724-736`) recomputes both in Python after commit, as today; the kernel returns neither.

**Sentinel pick:** the shadow dir holds one `*.hash` by contract; when it holds more, both
backends take the LEXICALLY GREATEST name (names are `<epoch>_…`, so that is the newest). Today
`_hash_file` takes `next(iter(glob))` — filesystem order, undefined (`fs_record.py:612-619`; §14).

`index_required` reproduces `fs_record.py:682-706` exactly: no sentinel or
`content_digest != sentinel hash` → True; 3-part sentinel → `path_digest != third part`;
2-part sentinel → read `shadow_dir/metadata.json`'s `asset_ref` and compare to `asset_path`,
unreadable or absent → False ("can't tell — treat as fresh"). An unreadable shadow dir counts as
"no sentinel" (`_hash_file` catches `OSError` → None).

Conformance: for every registered type, `fingerprint(rule(type), path) == str(asset_hash_fn(ref))` on
the stamps fixture (bench 6's 5,000 dirs plus one fixture per folder type — the 606 mismatches
of bench 7 were exactly the un-ported bespoke functions). A type whose function the exporter
cannot express is not an error: the wrapper computes its fingerprint in Python and passes
`ProbeRequest.fingerprint`, so the kernel still does the sentinel glob and digests — fail-open per
type through one code path.

Compatibility: `FSRecord.index_required` / `orphan` / `get_hash` stay as properties (`orphan`
is §7's concern — the sweep reads it per discovered record, `index_function.py:1413-1414`); the
indexer's `_probe_chunk` builds `ProbeRequest`s for a chunk and reads `Probe.index_required`.
The `FSRecord` built at `index_function.py:947` is still built (no I/O) because it travels in
the chunk tuple (`:1046`); only its `index_required` question is answered by `Probe`.

## 7. ShadowStore — enumeration of `<records_root>/<type>/<id>/`

Replaces the disk half of `FSRecord.discover` / `iter_discovered` / `count` /
`type_has_pending_changes` (`fs_record.py:544-574, 749-758`) and
`FSIndexer._discover_records_dir_ids` (`index_function.py:1513-1539`). Callers keep getting
`FSRecord` objects (`cli/auth/secrets.py:40`, `fs_store/record_list.py:26`,
`operations/record_error.py:39,48`, `indexer/index_log.py:389,527`,
`functions/claude_projects.py:196`, `builtin/faas/pty_actions.py:714`) or id sets
(`builtin/faas/fs_records_actions.py:786`); `FSRecord` builds them from `ShadowRecord`.

```python
class ShadowRecord(DataSpec):
    spec_kind = "diskio.shadow_record"
    type_name: str
    dir_id: str                                            # folder name as found (legacy "<type>-@<uuid>" included)
    meta_id: str | None                                    # the id metadata.json carries
    asset_ref: str | None                                  # AS STORED (unresolved) — FSRecord.from_dict resolves as today
    fields: dict | None                                    # the whole metadata.json, only when load_meta=True
    indexed_epoch: int | None                              # the three parts of the sentinel stem (_indexed_parts,
    indexed_hash: str | None                               #   fs_record.py:620-629), looked up at
    indexed_path_digest: str | None                        #   records_root/<type>/<meta_id>/ — TODAY's rule; None = none
    error: ItemError | None                                # kinds: unreadable (metadata.json) | parse (not a JSON object)

class ShadowStore(Protocol):
    def ids(self, records_root: str, types: Sequence[str] | None) -> dict[str, tuple[str, ...]]: ...  # dir names holding metadata.json
    def records(self, records_root: str, types: Sequence[str] | None, *, load_meta: bool,
                threads: int = 1) -> Iterator[ShadowRecord | StreamEnd]: ...
    def pending(self, records_root: str, rules: dict[str, FingerprintRule], *, threads: int = 1
                ) -> dict[str, bool]: ...                                                        # short-circuits per type
```

The sentinel is looked up where Python looks today — at `(type, metadata id)`, NOT the enumerated
folder (bench 7: 41,173 legacy-named dirs therefore read as never indexed). Changing that is
OPEN DECISION 5, not a backend detail. The sentinel pick follows §6. `indexed_at`
(`index_log.py:413`) is `datetime.fromtimestamp(indexed_epoch, utc).isoformat()` in the wrapper.
A record whose `metadata.json` is unreadable or not a JSON object is yielded with `error` set;
the wrapper skips it, as `iter_discovered` skips today (`fs_record.py:566-574`).

**Measured wins, per method, at the caller's shape.** `pending`: `get_index_status` asks it per
default type on every status request (`index_log.py:389`) — bench 7 unit 4 at that shape
(all types, short-circuit per type): 7.5 s Python, 2.0 s Rust serial, 0.9 s Rust rayon.
`ids`: the orphan sweep (`index_function.py:1344` → `_discover_records_dir_ids`) — bench 7
unit 1: 484 ms → 288 ms (1.7x). `records(load_meta=True)`: **unmeasured end to end**. Bench 7
unit 2 ran all 98 types and had Rust emit field COUNTS, while every SDK caller of `discover`
asks for ONE type and needs the whole `metadata.json` dict (`secrets.py:40`, `record_list.py:26`,
`record_error.py:39,48`, `index_log.py:527`, `claude_projects.py:196`, `pty_actions.py:714`); at
that shape the Python construction of one dict per record is the floor, so the gain is the disk
overlap of `threads` only. The 15 s / 941 MB figure of `01_io_sites.md` is the all-types shape
no caller uses. Before the Rust backend claims a number for `records`, the conformance kit runs
one perf case: `records(load_meta=True)` for one 9,566-record type (markdown) with full
`fields` through pyo3, Python vs Rust.

`pending` composes §6 per record with the type's rule and stops at the first pending record per
type. **A `ShadowRecord` whose `asset_ref` is `None` or `""` is never pending and is never
probed**: `index_required` is False for it today (`fs_record.py:590-591` — `get_hash` returns
`""`; `:682-706` — `"" != ""` is False, no sentinel parts, `_persisted_asset_path()` is None →
`False`) and `write_hash` never stamps it (`:724-727`), so it holds no sentinel to compare.
`pending` skips it, and the wrapper never builds a `ProbeRequest` for it (`ProbeRequest.asset_path`
is a RESOLVED path, never empty). This is the majority of the store, not an edge: 38,989 of the
63,256 records on this machine (annotation, flow_message, workspace, record_error, deployment,
3,026 of 3,073 projects, …) carry no `asset_ref`; a backend that evaluated the `stat` rule on an
empty path would report those types pending forever to the status poll (`index_log.py:389`).
Conformance: a type dir holding only asset-less records → `pending[type] is False` on both
backends; a mixed dir whose only asset-bearing record is fresh → `False`. Inside `pending` (and for `records`' sentinel comparison) the kernel
RESOLVES `asset_ref` per §0's definition before computing the path digest and before the 2-part
sentinel comparison — `FSRecord.from_dict` builds an `FSRef`, which resolves (`fs_record.py:534-541`,
`:654-658`; bench 7 digested `str(Path(asset_ref).resolve())`). `ShadowRecord.asset_ref` itself is
returned unresolved.

## 8. SessionReader — Claude and Codex session stats

Replaces the inside of `_parse_jsonl_stats` (`functions/_claude_session_stats.py:66-230`) and
`_parse_codex_jsonl_stats` (`_codex_session_stats.py`), each with ONE caller that caches
`value.model_dump()` on the record (`:257`, `:265`). The two dicts are declared field-for-field
with today's key names so the cached dict is byte-identical; there is no shared base beyond
`path` / `error`, and no `first_timestamp(paths)` method (no caller outside the parser).

Two things leave the kernel because they are not JSONL facts: `task_path` (a glob of
`claude_tasks_dir/<session_id>/*.json`, `:198-201`) and `estimated_cost_usd` (a rate table in
Python, `:29-61`); the wrapper fills both from the value's token counts and `primary_model`.

```python
class ClaudeSessionStats(DataSpec):
    spec_kind = "diskio.session_stats.claude"
    path: str
    session_id: str; cwd: str; version: str; git_branch: str; slug: str
    model: str | None
    message_count: int; user_message_count: int; assistant_message_count: int
    input_tokens: int; output_tokens: int; cache_read_input_tokens: int; cache_creation_input_tokens: int
    duration_ms: int
    tools_used: tuple[str, ...]                            # sorted
    has_plan: bool
    last_stop_reason: str | None
    last_user_message: str | None                          # first text block, [:200] code points, not starting with "<"
    modified_at: str | None                                # CPython fromtimestamp → naive local isoformat (bench 8 rounding)
    models_used: tuple[str, ...]                           # sorted keys
    primary_model: str | None                              # max count, first-seen tie-break
    created_at: str | None                                 # first "timestamp"
    search_content: str | None                             # slug, cwd, then "user: …" / "assistant: …[:500]" lines
    error: ItemError | None                                # kinds: unreadable | decode (stats so far are kept)
    # wrapper adds: task_path, estimated_cost_usd  → 25 keys, today's names

class CodexSessionStats(DataSpec):
    spec_kind = "diskio.session_stats.codex"
    path: str
    session_id: str; cwd: str; version: str; originator: str; git_branch: str
    model: str | None; effort: str | None; personality: str | None
    approval_policy: str | None                            # str(dict) repr when the payload is a mapping (bench 8)
    sandbox_policy: str | None
    message_count: int; user_message_count: int; assistant_message_count: int; tool_uses: int
    input_tokens: int; output_tokens: int; cache_read_input_tokens: int; cache_creation_input_tokens: int
    last_user_message: str | None; last_assistant_message: str | None; last_stop_reason: str | None
    modified_at: str | None; created_at: str | None
    estimated_cost_usd: float = 0.0                        # the module returns a constant
    models_used: tuple[str, ...]; primary_model: str | None
    search_content: str | None
    worker_type: Literal["codex"] = "codex"
    error: ItemError | None                                # kinds: unreadable | decode  → 28 keys, today's names

class SessionReader(Protocol):
    def claude(self, paths: Sequence[str], *, threads: int = 1) -> Iterator[ClaudeSessionStats | StreamEnd]: ...
    def codex(self, paths: Sequence[str], *, threads: int = 1) -> Iterator[CodexSessionStats | StreamEnd]: ...
```

**Line handling both backends reproduce** (bench 8, plus the three edges decided in v2):
universal newlines; `str.strip` including `\x1c-\x1f`; code-point slices; Python truthiness on
`raw.get(...)`; a line that is not a JSON object, or not valid JSON, is skipped; **a line whose
JSON holds a non-finite number (`NaN`, `Infinity`, `-Infinity`) is a malformed line and is
skipped** (today `json.loads` accepts it and the value later raises or poisons a sum); **a byte
sequence that is not UTF-8 ends the file with `error.kind="decode"` and the stats aggregated so
far** (the same rule as a mid-file `OSError` → `"unreadable"`: keep what was aggregated); **a
lone surrogate inside a JSON string is replaced by U+FFFD before any field is built** (it cannot
cross pyo3 or NDJSON otherwise). Today the decode and non-finite cases raise out of `from_disk_fn`
(`_claude_session_stats.py:99-106`, `:172,194`; `_codex_session_stats.py:86-93`) — §14.

Compatibility: `_parse_jsonl_stats(path) -> dict` returns `value.model_dump()` with `path` /
`error` removed and `task_path` / `estimated_cost_usd` added; same for Codex.

## 9. TreeHasher — the Merkle doc tree (composes §1's walk and §5's rules 7 and 8)

Replaces the inside of `llm_index/core.py::scan_tree` (`core.py:132-224`). `scan_tree(root, *,
gitignore, on_node)` stays the public function and rebuilds today's `FolderNode` / `FileNode`
dataclasses (with `path: Path = root / rel_path` and their properties) as nodes arrive, so
`LLMIndexer` (`llm_index/indexer.py:425`), `rag/indexing.py:83,169` and the markdown_index skill
are untouched. It does NOT compose §4: `scan_tree` reads titles and `index.md` frontmatter
through the LENIENT `MarkdownDocument` parser (`markdown_document.py:44-75`: `key: value` lines,
`- item` lists, `true/yes` coercion), which is a different grammar from strict YAML (bench 10
ported it). It takes no `LinkGrammar`: `wiki_links` is §5 rule 7 (a scan of the unmasked body)
and `title` starts from rule 8 — neither reads a grammar field.

Nodes stream post-order so the wrapper can fire `on_node(path, kind)` per file and per folder
exactly as `core.py:191,218` does today (`LLMIndexer.scan` turns it into `ScanTick`s). The two
kinds interleave in one iterator and end with one `StreamEnd` (§0 Completeness).

```python
class FileNodeValue(DataSpec):
    spec_kind = "diskio.file_node"
    rel_path: str
    content_hash: str                                      # sha256 of the raw bytes
    title: str                                             # H1 (§5 rule 8) → lenient frontmatter title → stem (MarkdownDocument.title)
    is_folder_note: bool                                   # stem == parent dir name, case-insensitive
    wiki_links: tuple[str, ...]                            # == DocText.wiki_words (§5 rule 7)

class FolderNodeValue(DataSpec):
    spec_kind = "diskio.folder_node"
    rel_path: str                                          # "" for root
    files: tuple[str, ...]                                 # rel_paths of its FileNodeValues, folder note excluded, already yielded
    folder_note: str | None                                # rel_path of the folder note, if any
    subfolders: tuple[str, ...]                            # rel_paths of its FolderNodeValues, already yielded
    own_hash: str; inputs_hash: str
    existing_hash: str; manual: bool; ground_truth: bool; has_index: bool; index_title: str

class TreeHasher(Protocol):
    def scan_tree(self, root: str, policy: WalkPolicy, *, threads: int = 1
                  ) -> Iterator[FileNodeValue | FolderNodeValue | StreamEnd]: ...   # post-order; the root folder, then StreamEnd
```

**Constants are the contract** (`core.py:51-53`, `index_document.py:33`; no caller can vary
them, so they travel as rules, not fields): the own-hash preamble is
`template_version=1\nprompt_version=1\n`; a source file is one whose `Path.suffix.lower()` is
`.md` or `.mdx` (`core.py:157` — a bare `.md` dotfile has suffix `""` and is NOT a source: one
conformance case); `index.md` is excluded by NAME and its frontmatter is read with the lenient
`MarkdownDocument` grammar for `existing_hash` / `manual` / `ground_truth` / `index_title`. A
`TEMPLATE_VERSION` bump edits this paragraph, exactly as it edits the constant today. The
wrapper passes `WalkPolicy(gitignore=gitignore, file_exts=(".md", ".mdx"), …lists from
gitignore.py)`.

Hash inputs, byte for byte (bench 10): `own_hash = sha256(preamble + "file\0<name>\0<hex>\n"
per file sorted by name)`, folder note and `index.md` excluded; `inputs_hash =
sha256("own\0<own_hex>\n" + "child\0<name>\0<hex>\n" per subfolder sorted)`. `content_hash` is
over the RAW bytes; title and wiki links are extracted from the bytes decoded as UTF-8 with
U+FFFD replacement (`core.py:167`). An unreadable source file is dropped from the folder
(today's `OSError → None`). The wrapper keeps `root = Path(root).resolve()` and raises
`NotADirectoryError` before calling the kernel (`core.py:146-148`).

## 10. Paths — unchanged, Python (note)

`canonical_posix_path`, `is_protected_path`, `ancestors_of`, `is_path_under`, `VFSPath` and
`type_id` parsing keep their code: every one of their call sites is single-path (01_io_sites §D),
bench 11's verdict on `canonical` is "lstat-bound; call it less", and the stage-1 child never
emits a canonical path (`ScanRoot.path` is RESOLVED by the parent; the walk is AS GIVEN). The two
measured wins are Python-side and live in the §14 Paths row: the protected-root cache
(331 → ~46 µs per classify) and a memoized `resolve()` per scan run.

## 11. Git — unchanged, Python (note)

`GitRepo` (`builtin/faas/git_repo.py`) is already the seam — it runs on the compute node, possibly
remote, through `compute_node.run_command`, and `_git` never raises (`:321-336`) — and
`GitStatus` / `GitStatusFile` (`:88-113`) are already the value the UI reads. Bench 12: gix is
1.3x over bare git; the cost is spawn count. The one measured change is the §14 GitRead row:
`get_status(line_counts=)` runs ONE shell script per poll (status + `ls-remote --get-url` +
the numstat set + the operation probe when the porcelain shows unmerged paths or no branch),
8 spawns → 1. `git_assets_introduction` (`utils/git.py:388-449`) is unchanged: one shared
`log --full-diff -M --name-status --diff-filter=AR` walk, then `--follow` only for paths it
reported as renamed — a correctness cost for `resolve_asset_collisions` (R2-8).

**Boundary.** This note covers READ-ONLY questions: `get_status`, `git_assets_introduction`, and
`ignored_under` (`utils/git_ignore.py:109-135`: `ls-files -z --others --ignored
--exclude-standard --directory`, the production shape of "what does git exclude under this
root" — a set of paths, not a per-path `check-ignore`; it is what `copy_folder` uses to skip
ignored files). Every git MUTATION — `core/flow/flow_source_control.py` (clone / fetch / commit /
push), `actions/fs/asset_versioning.py::commit_asset_change`, `builtin/project.py::
_detach_git_history`, `assets/hub_repo_sync.py::local_tree` (`git add -A` into a throwaway
index) and the other ~18 spawn-only modules — stays where it is and is not an I/O-interface
concern (§16 T14). The `running_commands` retention (`01_io_sites.md` §E: 295 `CLICommand`s after
20 minutes) is a bug to fix in `compute_node`, not a seam.

## 12. Archive and hashing — unchanged, Python (note)

`safe_extract_zip` (already parametrised: `max_bytes`, `max_members`, returns `None`, raises
`UnsafeArchiveError`), `_zip_bundle`, `build_dir_zip` and `file_hash` (one single-path caller)
keep their code. Bench 13: 0.8-1.6x, syscall-bound, "no case". `fs_actions.download_zip` remains
a stub; when it is implemented it calls `build_dir_zip` in Python (§16 T7) — there is no
`Archive.pack` to point it at since v3.

## 13. Hierarchy, the stage-1 scan child, and where each backend runs

```
STAGE 1 — kernel: Scanner.scan(request) — ONE ScanRequest in, the tagged stream out, on either
          transport (the Rust child binary over NDJSON, or the pyo3 module as an iterator):
    TreeWalker ──► WalkEntry lines              (one per surviving dir, per root; error on unreadable)
    DeclaredScanner ──► ScanCandidate / ScanProblem lines
                                            (scan(root, root.kind, specs) per root;
                                             scan(dir, "folder", folder-rooted specs) per WalkEntry —
                                             keyed by ScanCandidate.parent == WalkEntry.dir;
                                             fused inside Scanner: the specs are marshalled ONCE)
    progress lines (IndexProgressTable shape, untagged) ; mandatory terminal StreamEnd

STAGE 2 — Python, in the server process, consumes stage 1:
    TRISTATE roots: reads the ROOT WalkEntry's error → PermissionError-class errno → mark_denied
    FOLDER expander (project_folder_walker over WalkEntry) → FSRef chain with scope / project_id /
    read_only inheritance → layout_walker attaches ScanCandidate lines by `parent` → scan_repo_tree per
    root (repo_assets.py, Python) → into-file walkers (hooks, MCP servers → json_path) →
    session expanders over the home WalkEntry (claude_projects_fn → claude_sessions_fn, codex,
    copilot: iterdir / glob("*.jsonl") under ~/.claude, ~/.codex, ~/.copilot — §16 T4) →
    markdown_in_folder_fn over WalkEntry.files (.md) → type gating +
    IndexerOptions.types/limit/limit_per_type/project_id + (path, type, json_path) dedup
      ⇒  the SAME FSRef list FSIndexer.scan() returns today.

INDEX (Python, server process):  reconcile ◄── DocumentRead.fields / raw_text (one read, §4)
                                 Prober ◄── FingerprintRule          ShadowStore.pending ──► Prober
                                 from_disk_fn ◄── DocumentReader, TextExtractor
                                 SessionReader[claude|codex]   TreeHasher ◄── TreeWalker, TextExtractor
                                 sync_to_db, write_hash, orphan sweep — untouched
```

**The stage-1 request** — one JSON document on the child's stdin, as today's child takes its
request (`subprocess_scan.py:144-146`; today's roots travel as candidate lines,
`scan_child.py:94`):

```python
class ScanRoot(DataSpec):
    spec_kind = "diskio.scan_root"
    path: str                                              # RESOLVED by the parent (§0); already-denied roots never appear
    kind: Literal["user_home_folder", "real_project_cwd", "cwd_root", "system_root"]

class ScanRequest(DataSpec):
    spec_kind = "diskio.scan_request"
    roots: tuple[ScanRoot, ...]
    policy: WalkPolicy                                     # file_exts = (".md",) for the FOLDER expander's markdown rule
    specs: tuple[TypeScanSpec, ...]                        # the type-gated set; a spec whose WalkSpec.roots holds
                                                           # "folder" runs against every WalkEntry (skill, spreadsheet, …)
    threads: int = 1                                       # a CAP on the child's / module's pool (§0 Thread budget)

class Scanner(Protocol):
    def scan(self, request: ScanRequest) -> Iterator[WalkEntry | ScanCandidate | ScanProblem | StreamEnd]: ...
```

`Scanner.scan` is the ONE stage-1 method, and both transports implement it: the child adapter
(spawn, write the request, read the tagged stream, verify `StreamEnd` and its counts) and the
pyo3 module (the same stream as an iterator whose LAST item is the same `StreamEnd`; exhaustion
without it is a stream failure — §0 Completeness). It composes the two primitives — per
root `TreeWalker.walk(root.path, policy)`, then `DeclaredScanner.scan(root.path, root.kind, specs)`
once and `DeclaredScanner.scan(entry.dir, "folder", folder-rooted specs)` per `WalkEntry` —
INSIDE the backend, so the spec list is marshalled once per request instead of once per
directory (~1,223 times per repo scan on the pyo3 path, bench 3's 0.27-2.2 ms per call against
a per-call conversion no bench measured). `TreeWalker.walk` and `DeclaredScanner.scan` remain
callable on their own: §9 and `scan_declared` call them directly. Order: TreeWalker pre-order per
root, each dir's folder-rooted candidates following its `WalkEntry`, so stage 2 attaches by
`parent` without buffering.

The parent builds the request from `IndexerOptions` + the registry export (bench 3's 638 ms
bootstrap stays in the parent); the child receives no `IndexerOptions`, no registry, no
settings. Type gating by reverse reachability, `limit`/`limit_per_type`/`project_id`, scope and
`read_only` inheritance, and `scan_repo_tree` per root are all stage 2.

**Child adapter — where the binary comes from.** The stage-1 binary is a `[[bin]]` target of the
kernel crate (§15.4 — a second crate, never the keychain crate's `flow-rs`), vendored at
`flow_sdk/rust/bin/<platform>/<name>` by the SAME package-data glob that ships the keychain
binary today (`pyproject.toml:125-128`, `rust/bin/**/*`; `<name>` is settled with OPEN DECISION 3
and is not `flow-rs`). The adapter locates it with a twin of `vendored_flow_rs_path()`
(`flow_rs_binary.py:38-63`): a `sys.platform` → (sub-dir, filename) table, `importlib.resources`,
`is_file()`, `None` on a platform without an entry (Linux today, exactly as the keychain binary —
`03_current_arch.md`: "Linux has none") or on a source checkout that holds no binary. One env
override for a locally built binary, `FLOWPAD_DISKIO_SCAN_BIN`, in the `FLOWPAD_RS_INDEXER_BIN`
shape (`rs_adapter.py:66-80`: absolute path, `is_file` + `X_OK`, else warn once and ignore). The
lookup is PURE and runs BEFORE selection (§0 Selector "Absent on this platform"): `None` means
`kernel(Scanner)` answers the pyo3 module if it imports and passes the contract-version check,
else the Python `Scanner` — no spawn is attempted, nothing latches, nothing is logged per
process. A present binary that fails `--contract-version` (§0 Selector) is treated as absent,
logged once. **Signing.** The keychain binary is signed because the keychain ACL trust list is
bound to the signing identity (`flow_rs_binary.py:9-13`); a scan binary reads directories and
needs no identity, so it is signed only if the deploy script's signing step is extended to the
second name. Either way `scripts/deploy_to_github.sh:292-297` must learn the second binary: its
`MAC_BIN` / `WIN_BIN` hard-code the ONE name `flow-rs`, and its "re-sign when the crate source
changed" rule reads `RUST_SRC_PATHS`, which must include the kernel crate's source. Decision: the
scan binary IS signed on macOS and Windows (one signing pipeline, no unsigned executable in the
wheel for Gatekeeper / SmartScreen to quarantine); the step is extended to a list of names.

**Child adapter — what latches and what does not.** Only a SPAWN failure of a PRESENT binary
latches the child off for the rest of the process (`OSError` from `create_subprocess_exec`; cleared
by `reset_child_availability()` as today, `subprocess_scan.py:42-56`; today's "`sys.executable` is
not a Python" reason belongs to `ScanMode.SUBPROCESS`'s `-m scan_child` spawn, `:136-140`, and
does not apply to a binary). A reader error — an unknown `spec_kind` (`_by_kind` raises
`ValueError`, `spec.py:460-468`), a line that fails `model_validate` (`ValidationError`, a
`ValueError` subclass), a count mismatch, a missing `StreamEnd`, a non-zero exit — is raised as
`RuntimeError` → the §0 Completeness fallback for THAT run, no latch. Version skew between binary
and wheel is NOT a reader error: it is caught by `--contract-version` at selection (§0 Selector)
and never reaches a stream. Today's clause `except (OSError, ValueError)` at
`subprocess_scan.py:84-99` would latch the first two reader errors; the comment at `:42-48`
already says data failures must not, and the adapter is written to that comment, not to that
clause. Conformance: a stream with one unknown-kind line falls back, and the NEXT scan spawns the
child again; a binary stub answering the wrong `--contract-version` is never spawned for a scan.

**Wiring.** Stage 1 + stage 2 is a third value of the existing `ScanMode` enum
(`auto_index.py:78-87`: `THREAD`, `SUBPROCESS`), **`TWO_STAGE` (`"two_stage"`)**, resolved by the same
chain that picks `subprocess` today — env `FLOWPAD_INDEX_SCAN_MODE` > pref
`preferences.auto_index.index_function` > default (`builtin.py:238-260`, `selected_scan_mode`) —
and applied only where that preference applies today: the auto-index path through
`get_auto_scan_indexer` (`builtin.py:280-304`); a manual Index click keeps the in-process walk
(`fs_records_actions.py:1406-1408`). Inside `TWO_STAGE`, `kernel(Scanner)` (§0 Selector) picks the
child adapter or the pyo3 module, and stage 2 is the Python described above. `ScanMode.THREAD`
— `FSIndexer.scan()`'s in-process DFS — stays as the fallback every stream failure lands on AND as
the ORACLE (goal 1): the two-stage pipeline is correct when it returns the same `FSRef` list. The
parity shape is `test_subprocess_scan.py`'s (`:27-45` `_ref_key`, parent chain included; `:93-110`):
for each available `Scanner` backend, `sorted(map(_ref_key, two_stage)) == sorted(map(_ref_key,
thread))` on the `project_tree` fixture, plus the existing fragment / parent-chain / project_id /
truncated-stream cases re-run under `TWO_STAGE`. Today's Python child (`ScanMode.SUBPROCESS`,
`scan_child.py`, which pins `THREAD` in the child — the fork-bomb guard, `:100-103`) is kept
until the two-stage mode has passed that test on both backends. The value has TWO UI homes, both
edited when it ships: the preference's option list `AUTO_INDEX_FUNCTION_OPTIONS`
(`prefRegistry.ts:394-405`) and the per-option labels at `pref-labels.ts:113-114`
(`'preferences.auto_index.index_function:subprocess'` / `:thread` — a third `:two_stage` entry,
translated into the he/ar catalogs via `locit`); `coerce_enum` accepts the string before that.

**The switch it replaces.** The repo already carries a Rust backend switch that this proposal
RETIRES: `indexer_backend` (env `FLOWPAD_INDEXER_BACKEND` > pref `advanced.indexer_backend`,
`rs_adapter.py:62-64`), consulted by `build_default_indexer` BEFORE `scan_mode`
(`builtin.py:63-76`: `rs = _maybe_rs_indexer(); if rs is not None: … return rs`, with
`index_function` logged as "a no-op"), so with it set `ScanMode` is never read and `TWO_STAGE`
would be unreachable. It drives `RSIndexerAdapter` around an `fsindexer-rs` binary that does not
exist on this machine or in any sibling checkout and whose `index --db --shadow-root` contract
would have a child write SQLite (`03_current_arch.md`), against the scan-child rule. Retired, as
one §14 row: `_maybe_rs_indexer()` and the `rs` branch in `build_default_indexer`,
`rs_adapter.py` (`RSIndexerAdapter`, `resolve_rs_indexer_bin`, `rs_backend_selected`),
`tests/unit/test_fs_store/test_rs_adapter.py`, `PrefKey.INDEXER_BACKEND` and its registry entry
(`prefRegistry.ts:39,339-348`), its two label strings (`pref-labels.ts:55,80`), the server default
`"preferences.advanced.indexer_backend": "python"` (`server/routes/bootstrap.py:1994-1995`) and
the assertion that mirrors it (`test_preferences_defaults_match_registry.py:117`), the last
sentence of the `index_function` description ("No effect when the Rust indexer backend is
selected", `prefRegistry.ts:401`), and the `indexer_backend` paragraph of
`docs/data-management/scan-and-discovery.md:153`. `ndjson_stream.py` stays (goal 1 lists the
candidate protocol; its docstring's two mentions of `rs_adapter` are wording). After the
retirement there are exactly TWO switches: `advanced.diskio_backend` — WHICH implementation
(`kernel()`, §0 Selector) — and `auto_index.index_function` — WHERE the walk runs (`ScanMode`).
`tests/pytest_plugin.py` pins `FLOWPAD_DISKIO_BACKEND=python` and `FLOWPAD_INDEX_SCAN_MODE=thread`
beside its existing `FLOWPAD_DISABLE_VENDORED_FLOW_RS=1` (`pytest_plugin.py:180`), so no unit test
outside the conformance kit selects Rust or the two-stage mode by accident; the kit instantiates
backends directly (§0 Conformance) and the parity test sets the mode explicitly.

**A sibling, not a stage.** The transcript catch-up child
(`transcript_streamer/catch_up_child.py`, spawned from `server/app.py:711` after the first
bootstrap) is a second Python NDJSON producer under the same rules — never opens the instance DB
(`:22`), one record per file, a mandatory terminal `{"result": …}` line (`:97`), fail-open with
a latch (`catch_up.py:26-29`). It parses transcripts with the Python fold and is NOT a stage of
this pipeline and not a piece of this proposal (§16 T1).

**The stream**: `WalkEntry`, `ScanCandidate`, `ScanProblem` lines under the §0 envelope, in TreeWalker
pre-order per root with each dir's folder-rooted candidates following its entry (so stage 2 can
attach by `parent` without buffering), progress lines interleaved, one `StreamEnd` with
`{"diskio.walk_entry": n, "diskio.scan_candidate": n, "diskio.scan_problem": n}`. On BOTH transports the
parent refuses a stream without `StreamEnd` or whose counts disagree — today's
`subprocess_scan.py:160-171` rule, now also the pyo3 iterator's (§0 Completeness) — and falls back
to the `ScanMode.THREAD` scan, never a partial set: the orphan sweep (`index_function.py:1335-1346`)
keys off the stage-2 result, which only exists when stage 1 completed.

**Protected roots.** A TRISTATE root (`special_folders.classify_special_folder`) is probed
today by `os.scandir` in the FOLDER expander (`project_folder_walker.py:40-62`): `PermissionError`
→ `mark_denied` so macOS never re-prompts. Under stage 1 the kernel's readdir IS that first
read; the root's `WalkEntry` arrives with `error.kind="unreadable"`, `detail="EPERM"` /
`"EACCES"`, and stage 2 runs the same `mark_denied` on it. A kernel never classifies special
folders and never writes Python state. Roots already `denied` are filtered in Python before
the request is built, as today.

What this corrects from v0 (kept from v1): today's scan child runs the FULL `FSIndexer.scan()`
and emits RESOLVED `scope`/`project_id`/`read_only` with `i`/`parent_i` links
(`scan_child.py:105-122`, `ndjson_stream.py:21-31,90-131`). The Rust binary is a NEW stage-1
producer with its own tagged line kinds, not a replacement speaker of today's candidate line.
Today's Python child and its candidate protocol (`ndjson_stream.py`) are untouched (goal 1 lists
them). The composed pipeline's acceptance test is `tests/unit/test_fs_store/test_subprocess_scan.py`
(parity with in-process scan, fragments keep `json_path`, parent chain, project_id inheritance),
run with `ScanMode.TWO_STAGE` as the second mode and `THREAD` as the oracle (Wiring, above).
The Rust child removes the per-auto-index cost of a Python interpreter + `flow_sdk` import,
measured at ~1.5 s (01_io_sites.md §A, `subprocess_scan.py` row); the registry export stays in
the parent, so the saving is the child's import, not the registry.

## 14. Python backend v1 — what the Python implementation does differently (in scope)

| Piece | Change | Evidence |
|---|---|---|
| TreeWalker | an unparseable `.gitignore` line is dropped (today it aborts the root's walk, `gitignore.py:128-137` catches only `OSError`) — in `push_gitignore`, so the §2 watcher inherits it; `WalkEntry.error` carries the errno; `file_exts` lists only the asked suffixes | R2-4 probe; `project_folder_walker.py:40-62` |
| TreeWalker / markdown | `markdown_in_folder_fn` reads `WalkEntry.files` (`file_exts=(".md",)`) instead of `glob("*.md")` per FOLDER node | `markdown.py:14-18`; per-folder glob cost: to be measured |
| DocumentReader | `yaml.CSafeLoader`-based strict loader (libyaml is installed) with the §4 constructor subset; one read per asset through the §4 seam: `_probe_chunk` calls `read(paths)` once per chunk and sets the transient `ref.document`, which the Frontmatter carrier, `read_main` and `read_asset_data` consult before opening the file — the generic extractor reads 4x today and `reconcile` a 5th time; `fields` dates → raw scalar text | bench 4 (1.6x alone); profile 924 reads / 231 files; `reconcile.py:47-49`; `index_function.py:937-973` |
| JSON mains (§4, Python) | one read per entity document: the `_read` triple (`raw`, `doc`, `body`) of `entity_document.py:45-58` is set on the same transient `ref.document` shape and handed to the `JsonRoot` carrier (`identity_carrier.py:357-359`), `read_main` (`serialization.py:237-262`) and the per-type `from_disk` readers (`data_driver.py:38-41` and the `assets/types/*` family) instead of each opening the manifest again | three to four reads of one small manifest per record; no bench (not a kernel method, §16 T2) |
| from_disk_fn path | `derive_markdown_context` stops re-walking `doc_search_dirs` per file; cache per run | profile: 0.97 s of 2.37 s |
| Paths (§10) | cache the six protected-root keys per request in `is_protected_path`; memoize `Path.resolve()` per raw string within one scan run (`FSRef.__init__` keeps resolving — the stored `asset_ref` and the path digest depend on it, `fs_ref/base.py:42`, `fs_record.py:661-665`) | bench 11: 331 µs → ~46 µs; 6,918 resolves / 231 files |
| GitRead (§11) | one shell script per question (status + remote + numstat + conditional operation probe in one invocation); `introduced` keeps today's one-shared-walk-then-`--follow`-for-renamed algorithm | bench 12: 8 spawns per poll; 197/200 parity with follow |
| Prober | sentinel pick = lexically greatest `*.hash` (today: filesystem order) | `fs_record.py:612-619` |
| ShadowStore | SEQUENTIAL in the Python backend; `threads` is honoured by the Rust backend only. Measured in iteration 4 on the real store (98 types / 63,256 records, `type_has_pending_changes` per type, `ThreadPoolExecutor(8)` vs serial, registry not bootstrapped so every type ran the `stat` rule, one pass each): cold page cache 9,267 ms serial → 4,440 ms threaded; WARM 2,335 ms serial → 4,293 ms threaded. A status poll runs warm, so a Python pool loses there. The bench-7 "8-9x" rows are Rust rayon | bench 7 units 1/4 (rayon 7.9-8.9x); the 4-run table in `iterations/04_arch.md` (R4-4) |
| DeclaredScanner | fix `scanning.py:212` positional `AssetScanIssue` (in `scan_repo_tree`, Python) | bench 3 |
| SessionReader | SEQUENTIAL in the Python backend (`json.loads` per line under the GIL, `_claude_session_stats.py:99-106`; no Python-side threaded measurement exists); `threads` is honoured by the Rust backend. Invalid UTF-8 → `error.kind="decode"` + partial stats, non-finite JSON number → line skipped (today both raise out of `from_disk_fn`) | bench 8/9: Rust 3-4x serial, 26-33x rayon — Rust rows, not Python ones |
| Scanner wiring (§13) — RETIREMENT | the `indexer_backend` Rust switch and everything that serves it are removed: `_maybe_rs_indexer()` + the `rs` branch of `build_default_indexer` (`builtin.py:63-76, 307-336`), `rs_adapter.py` (`RSIndexerAdapter`, `FLOWPAD_RS_INDEXER_BIN`, `FLOWPAD_INDEXER_BACKEND`, `advanced.indexer_backend`), `test_rs_adapter.py`, `PrefKey.INDEXER_BACKEND` + registry entry + two labels (`prefRegistry.ts:39,339-348`; `pref-labels.ts:55,80`), the bootstrap default + its test (`bootstrap.py:1994-1995`; `test_preferences_defaults_match_registry.py:117`), the "No effect when the Rust indexer backend is selected" sentence (`prefRegistry.ts:401`), the scan-and-discovery.md paragraph (`:153`). Two switches remain: `advanced.diskio_backend`, `auto_index.index_function`. `pytest_plugin.py` pins `FLOWPAD_DISKIO_BACKEND=python`, `FLOWPAD_INDEX_SCAN_MODE=thread` | `builtin.py:63-76` pre-empts `scan_mode`; the `fsindexer-rs` binary does not exist (`03_current_arch.md`); `00_goal.md` "one switch with fail-open" |

Removed from v0's table: "stop resolving in `FSRef.__init__`" (a silent behaviour change,
R1-10) and "fix the sentinel lookup for legacy dirs" (a data migration, now OPEN DECISION 5).
Removed from v1's table: "introduction without per-path `--follow` unless asked" (R2-8: it
would change collision resolution). Nothing removed in v3: the Paths and GitRead rows are now
the only home of those pieces' changes. Changed in v4: the ShadowStore and SessionReader rows no
longer claim a Python-side parallel win (one was measured and lost warm, the other was never
measured); the "JSON mains" row is new. Every parallel number in this table was measured with
one unit running alone (§0 Thread budget).

## 15. Open decisions (kept open for the user; the loop lists options and trade-offs)

1. **YAML scalar profile** (`DocumentReader.read(profile=)` default): `yaml11` (what PyYAML does,
   minus the five constructors §4 excludes — Rust must emulate 1.1 scalar resolution for bool /
   int / float forms; no maintained crate does, but the subset is small once timestamps and
   binary are text), `yaml12` (serde_yaml's default; changes typing of yes/no, octal, `1e3`,
   dates in hand-authored files — none occur in the real corpus, bench 4), `strings` (no typing
   at parse; the `DataSpec` field types coerce — safest for interchange, changes `fields` for
   the non-DataSpec readers in §4's first table row).
2. **Fingerprint rule v2** (`FingerprintRule.version=2`): integer fingerprints (`Σ mtime_ns+size` as an int,
   `max st_mtime_ns`) instead of Python float repr; costs one full re-index of the 15 folder-type
   rules' records. The sentinel carries no version: "coexistence" means a v1 sentinel simply
   mismatches a v2 fingerprint and re-indexes once — which is that cost.
3. **Package name**: `diskio` is a placeholder.
4. **Rust packaging (extension and binary).** Facts that hold whatever is chosen: the flowpad
   wheel is pure setuptools today, `py3-none-any`, no `ext_modules` (`pyproject.toml:1-3`);
   `requires-python = ">=3.11"` (`:10`), and 3.11 / 3.12 / 3.13 are all in the wild (`uv tool
   install flowpad` takes whatever Python uv holds); the existing crate builds its pyo3 cdylib
   WITHOUT an `abi3` feature (`flow_sdk/rust/Cargo.toml:24`), so that `.so`/`.pyd` imports on
   exactly one Python minor; its `.gitignore` ignores `*.so *.dylib *.pyd`; its module name
   `flow_rs` is the keychain module's (`src/lib.rs:56`, `rust/pyproject.toml` `module-name`);
   CI has no cargo / maturin step (`.github/workflows/`: `test.yml`, `ui-typecheck.yml`,
   `windows-wheel-deps.yml`). **Stated once, independent of the option:** the kernel extension is
   built `abi3-py311` (one artefact per OS×arch imports on every supported minor; the pack's own
   precedent is syncmd's `abi3-py39`); the kernel is a SECOND crate — or a second cdylib target
   with its own module name, settled with decision 3 — and never the keychain module `flow_rs`;
   the stage-1 binary is a `[[bin]]` of that crate (§13 "Where the binary comes from").
   Options for WHERE the extension ships:
   - **(a) Inside the flowpad wheel** (maturin or setuptools-rust as the build backend). Ends the
     `py3-none-any` wheel: one wheel per OS×arch (×Python minor unless abi3), `uv build` becomes
     a per-platform matrix, `deploy-pypi` and the e2b template pin change, a platform without a
     wheel cannot install flowpad at all (no fail-open — the sdist would need a Rust toolchain).
   - **(b) Vendored extension beside the binaries** — `flow_sdk/rust/bin/<platform>/<module>.abi3.so`
     / `.pyd` as package-data under the existing glob. Keeps ONE pure wheel; REQUIRES `abi3-py311`
     or it imports on one minor only and every other user falls open to Python silently; needs
     the crate `.gitignore` to admit the artefact (or a different directory); the artefact is
     committed like the signed binaries are today (`deploy_to_github.sh:286-297`); Linux gets
     Python until a Linux artefact is produced and committed; absence IS the fail-open.
   - **(c) A separate distribution on PyPI** — what `flow_sdk/rust/pyproject.toml` already IS
     for the keychain module (a maturin project): `flowpad-<kernel>` built `abi3-py311` with
     cibuildwheel for macOS / Windows / Linux, an OPTIONAL dependency the flowpad wheel never
     contains (`pip install flowpad[rust]` or a separate install). The main wheel stays pure,
     Linux is one more cibuildwheel target, absence IS the fail-open, and the version pin is the
     `CONTRACT_VERSION` check (§0 Selector), not a dependency specifier. Costs a second release
     pipeline and a second PyPI name.
   The stage-1 BINARY ships the same way in every option — vendored under `rust/bin/<platform>/`
   by the existing glob, signed by the extended deploy step (§13) — because it is an executable,
   not an importable, and today's pattern already exists for one. The conformance kit's Rust leg
   runs in CI only once the chosen route builds the artefact there (§0 Conformance 1).
5. **Legacy shadow dirs** (41,173 of 63,256 record dirs are named `<type>-@<uuid>` while
   `metadata.json.id` is the bare uuid, so the sentinel lookup at `(type, id)` misses and every
   such record reads as pending, bench 7). Options: (a) rename the folders once — a migration
   under the no-migration rule, one pass over the store, no re-index; (b) `ShadowRecord.dir_id ≠
   meta_id` makes `write_hash` stamp into the ENUMERATED dir and the probe look there — no
   rename, but two spellings of `shadow_dir` forever; (c) leave it: those records re-parse on
   every run until something rewrites them. The Python v1 backend keeps today's behaviour until
   decided.

## 16. Excluded I/O, by theme (the 701 substantive uncovered functions of `07_io_coverage.md`)

Each theme is excluded for a stated reason and names the condition under which it would
re-enter as a piece. "Excluded" means: no Protocol, no value class, no §14 row unless one is
named; the code stays Python where it is. Function counts are the audit's.

**T1 — Transcript read side (5 functions). Excluded.** The per-tick read
(`transcript_analyzer/transcript.py:336-395`, `_read_and_fold`: `stat` → `seek(_byte_offset)` →
iterate `b"\n"` lines → `_feed_line` → `_refold`) is one file and one appended line per WS
tick — no batch, no benchmark row — and its cost is `_refold` (`:420`; 0.44 s/line on an 83 MB
session), which `00_goal.md` puts out of scope. The boot catch-up has already left the server
process: `server/app.py:700-713` discovers pending JSONL files and hands them to
`catch_up_child.py` (§13 "A sibling, not a stage"), a Python child whose per-file cost is the
same parse + fold. A kernel delta reader would hand rows back as Python dicts for a Python
parser — the cost class of `json.loads`, already C — so only the read loop is separable, and it
is unmeasured. The head peeks (`claude_sessions/codex_sessions._iter_head_json`: one `open`,
one line) and the tail readers (`worker_status._tail_status`, `tail_status_detail`,
`transcript_tail_status`: seek-from-end) are Python and get no mode on any piece. The catch-up
`_discover` `rglob("*.jsonl")` is a §1 walk with `file_exts=(".jsonl",)` the day `app.py` is
pointed at the wrapper. **Re-enters** only if a benchmark of the I/O half alone, at the catch-up
batch shape (1,195 files), shows a gain independent of the fold.

**T2 — Per-type readers and JSON mains (49 functions). Excluded as kernel work.** The
`assets/types/*` `from_disk` readers (`deck._load_manifest`, `skill.parse_skill_yaml_from_dir`,
`task._read_task_md_fields`, `workflow_run._load_journal`, …), `entity_document._read`,
`serialization.read_entity_json` and `JsonRoot._load` each read one small JSON or YAML file per
record; `json.loads` is C, the files are hundreds of bytes, no algorithm ports and no bench row
exists (the audit's own reading: "none is individually heavy, and none has a Rust-able
algorithm"). The real defect is three to four opens of the same manifest per record, and that
is the §14 "JSON mains" row through the §4 one-read seam (`ref.document`). `spreadsheet.
_extract_xlsx_sheets` (a zip member read) is rare and stays. **Re-enters** never as a method on
§4; if a profile ever shows the per-record JSON parse itself hot, that is a new benchmark unit
first.

**T3 / T5 / T6 — Writes: PTY recordings (5), shadow-store writes and atomic writers (28),
append logs and the transcript tee (42). Excluded.** Every write is one small file in the
server process, most of them after `sync_to_db` (`write_hash`, `save_metadata` —
`fs_record.py:435`, `_write_json_atomic` `:146-160`), with no batch shape and no measurement;
`00_goal.md` keeps DB sync and what follows it in Python. The open-per-line appenders
(`pty_stream_file.py:157-175`, `service_log._log_with_timer`, `trigger_log.append_entry`,
`index_log._append_jsonl`) and the twelve hand-rolled "tmp + compare + `os.replace`" writers
(`frontmatter._atomic_write_text_unlocked`, `capsules/atomic.atomic_write`, `cursors.flush`,
`config.save_server_info`, …) are a duplication worth removing in Python — one
`write_if_changed`, one held-fd append log with a size cap — and are NAMED here only so that is
on record: they are not part of this interface and get no Protocol. The JSONL tee
(`jsonl_tee_worker.py:163,337`) is a pipe, not a file algorithm. `write_hash` / `clear_hash`
stay listed under §6 as Python. **Re-enters** never as a kernel piece; a write-side piece would
need a batch shape that does not exist.

**T4 — Vendor-home session discovery (64 functions). Excluded.** Inside the indexer it is
already a stage-2 expander chain over the `user_home_folder` `WalkEntry`
(`claude_projects.py:52-58`: `Path(node.path) / ".claude" / "projects"` + `iterdir()`;
`claude_sessions.py:71-77`: `glob("*.jsonl")` per project node; codex / copilot likewise) and
stays one under §13. No `TypeInfo.walk` declares a vendor-home root (`grep roots=(
flow_sdk/schema/type_info`: only `user_home_folder` / `real_project_cwd` / `cwd_root` /
`system_root` / `folder`), so a `ScanRoot.kind` for one would serve no declared walk and is not
added. Outside the indexer, the 13 modules that re-implement `rollout-*` / `*.jsonl` discovery
(`worker_history`, `project_list`, `cli_drivers/*/session_history`, `transcript_analyzer/
resolver`, `project_cleanup`, `routes/transcripts`, …) collapse into one Python function per
driver (the driver already owns the root: `external_session_dirs`), cached per request. The
walk itself is a readdir-bound pass over a few thousand entries — bench 1's `gitignore=False`
shape, 1.49x — and bench 3's verdict "too small to spawn for" applies. **Re-enters** only if a
profile of a request path shows the walk (not the per-file head read) above the §1 TreeWalker's
per-root cost, in which case it is a §1 call with `file_exts=(".jsonl",)`, not a new piece.

**T7 — The HTTP/RPC fs surface (75 functions). Excluded.** `LocalStorageDriver`,
`fs_actions` browse/upload/write/rename/download, `push_entity_files_to_hub`, the desktop
provider's `list_dir` / `write_files`, `fs_mcp.str_replace_editor`, the route handlers: each
moves one request's worth of bytes, bounded by the HTTP body (`01_io_sites.md` §F: "not
benchmarked; request-sized"). `fs_actions.download_zip` is an unimplemented stub; when written
it calls `build_dir_zip` in Python (§12). `_handle_asset_usage._scan_one` (a `read_text` of
every skill-referencing file) takes its file list from §1 if it is ever profiled. **Re-enters**
never; a request-sized call has no batch.

**T8 / T9 — Tree copy, move, remove and deletion sweeps (92 functions). Excluded.** The
audit's theme table carries no T9; its function table labels the deletion sweeps "T8/T9"
(`data_source.remove_source_folder`, `Project._delete_with_children`, `RagIndex.destroy`,
`claude_env._rmtree_onexc`) — carried here under both numbers so neither is silent.
`materialize_asset_sync`, `transfer.pack_tree` / `restore_tree`, `hub_repo_sync`,
`flow_message_bundle` (31 pack/unpack functions), `ingest/write_back`, `compute_node.
_refresh_tree`, the `rmtree` sweeps: syscall-bound tree operations, the shape bench 13 measured
at 0.8-1.0x. The `rglob("*")` snapshots in `transfer.py` walk with no ignore rules — a bundle
carrying a `node_modules` is a 48,780-file walk — and become §1 `TreeWalker` calls with empty
`deny_basenames` / `skip_segments` and `gitignore=False` if profiled. **Re-enters** never as a
piece; the walk half is already §1.

**T10 — Dataset / data_schema folder layout (31 functions). Excluded for now.**
`schema/data_spec/io/{reader,writer}` (one file per field, one dir per example),
`layout.FolderLayout._scan`, `declared.data_schema_folders.walk`, `datasets/links`: per-row
folder I/O that scales with dataset size, and today's datasets are hundreds of rows.
**Re-enters** when a dataset reaches ~10⁴ rows: `FolderLayout._scan` is then a §1 walk over
`rows/`, and `_gather` a Python one-read pass — no new piece.

**T11 — RAG and LLM-index stores (15 functions). Excluded.** The heavy write is usearch's own
whole-file save (`rag/store.py::RagStore.flush`, `os.replace`); `rag/indexing.index_documents`
walks through §9 and could take `DocumentRead.body` from §4 instead of a second `read_text`;
`llm_index/indexer._write_blobs` / `_gc_blobs` and the sidecar writers are small files.
**Re-enters** never; the vector index is a library's file, not ours.

**T12 — File watching (3 functions). Excluded.** `fsop_watcher._run_watch_for`,
`file_watch._watch_loop`, `routes/watch.watch_transcript` are `watchfiles.awatch`, which is
already Rust (`notify`). The per-event cost is the filter — §2, a note, with its `resolve()`
floor stated there. **Re-enters** never.

**T13 — Instance and worker-runtime plumbing (112 functions). Excluded.** pid / lock / marker
files (`singleton_lock`, `deployment_process` flock, `manifest.bump`, `server.json`,
`stream_inbox.touch`), worker runtime files (`prompt_queue`, `process_io`, `turn_abort`,
`config_gen`, `credential_files`, `claude_settings_sync`, `agent_schedule` `trigger.json`,
`Trigger.read_file` / `write_file`), `config.init_desktop_env`, `sod/file_sod`: one small file
each on a boot or request path. Goal 3: "otherwise it is left alone". **Re-enters** never.

**T14 — Git outside §11 (2 substantive + ~18 spawn-only modules). Excluded.** §11's boundary
paragraph: this proposal answers read-only git questions (`get_status`,
`git_assets_introduction`, `ignored_under`) and names its one measured change (one shell script
per poll); every mutation — `flow_source_control`, `asset_versioning.commit_asset_change`,
`project._detach_git_history`, `hub_repo_sync.local_tree`, `project_dependencies`,
`git_share_preflight_action`, … — stays where it is. The `running_commands` retention is a bug
in `compute_node`, not a seam. **Re-enters** never as a kernel piece; git runs on the compute
node, possibly remote.

**`tags/bindings.py::scan_code_capsules` (outside the numbered themes). Excluded, unmeasured.**
It walks a root with `gitignore_walk` and, per comment-leader source file, `stat`s,
`read_text`s, tests for the capsule marker and runs `LineCommentCapsule(path).read_all("tag")`
(`bindings.py:159-183`) — a whole-tree read pass on two REQUEST paths (`routes/tags.py:146` when
`"code"` is asked for; `tags/graph.py:59` per graph build with a `code_root`). No bench row.
Its walk is §1 (`file_exts` = the comment-leader suffixes) the day it is pointed at the
wrapper. **Re-enters** as a §5 grammar candidate (`extract_capsules(body)`, a second grammar on
`TextExtractor`) only if a profile of the `/tags` request shows the read-and-mark pass hot.

**`path_utils.trash_path` (`send2trash`) and the 175 leave-alone functions. Excluded.** Small
single-file reads and writes on request or boot paths (`icons/registry`, `i18n`, `core/snippet`,
`core/wizard/local_run`, `diagnose/*`, `evals/*`, `semantic_lock/*`), every `migrations/*`
(runs once; no new migration is written by this loop), every `cli/*` command, the transcript
synthesizers. Goal 3. **Re-enters** never.
