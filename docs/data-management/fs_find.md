---
id: 38b2576d-c49f-5567-85e2-ae37a8b7a791
---

# Filesystem Discovery Benchmark

This document records the findings of a cross-platform benchmark comparing four methods of recursively finding files on disk: two Python walkers, one OS-native walker, and one OS-native index query. The investigation was triggered by a ~57 s bootstrap latency traced to markdown discovery (`doc_search_dirs()` → `_find_docs_subdirs()`) descending into contaminated scan roots (`/` and `$HOME`) returned by `iter_claude_project_paths()` in `flow_sdk/fs_store/indexer/functions/_claude_projects.py`.

The goal was to answer: **does switching from a Python walker to an OS-native index (Spotlight / plocate / Everything) materially speed up record discovery, and if so, at what scale does the crossover happen?**

For the neighbouring description of how discovery is consumed by the record layer, see [`scan-and-discovery.md`](./scan-and-discovery.md).

---

## Methodology

The bench harness (thrown away after results were captured; was hosted at `github.com/serans1/fs-discovery-bench`) creates a synthetic tree of 2,000 `.md` files scattered across ~200 nested directories, interleaved with `node_modules`, `.git`, `__pycache__`, `.venv`, `dist`, `build` noise directories. It then times four discovery methods, taking the median of 3 repeats per method:

1. **`Path.rglob('*.md')`** — pure-Python walk with no pruning.
2. **`os.walk` pruned** — pure-Python walk that skips standard noise directories (`node_modules`, `.git`, `__pycache__`, `.venv`, `dist`, `build`).
3. **OS-native walker** — `find <root> -name '*.md'` on Unix, `powershell Get-ChildItem -Recurse` on Windows.
4. **OS-native index query** — `plocate` on Linux, `mdfind` on macOS, Everything CLI (`es.exe`) on Windows.

The matrix portion (2 K synthetic files) ran on GitHub-hosted runners `ubuntu-latest`, `macos-latest`, `windows-latest`. The scale portion ran locally on macOS against real filesystem roots that Spotlight had already indexed.

---

## What we tried (per-OS indexer setup)

### Linux — plocate

`plocate` is installed via `apt-get install plocate`. A fresh database is built per-root with `updatedb`:

```
sudo updatedb \
  --require-visibility 0 \
  --prunepaths '' \
  --prunefs '' \
  --output <db> \
  --database-root <root>
```

Querying uses **trigram substring matching**, not globs:

```
plocate -d <db> .md
```

The `updatedb` cost is **not** included in the benchmark timing — it's a one-off indexing pass that in production comes from the system's nightly `updatedb` service.

### macOS — mdfind

`mdfind` queries Spotlight's metadata index:

```
mdfind -onlyin <root> "kMDItemFSName == '*.md'"
```

Spotlight indexes some paths by default and not others. Ephemeral CI paths like `$RUNNER_TEMP` are not indexed unless explicitly requested. The CI workflow calls `sudo mdutil -i on /`, then after the tree is built calls `mdimport <ROOT>` to nudge Spotlight, then waits 60 s. Even with this, coverage is not guaranteed (see Results below).

### Windows — Everything

Everything is a file indexer for Windows from voidtools. Two separate artefacts are required:

1. **The service + GUI**, installed via `choco install everything`. This is what builds the volume index in the background.
2. **The standalone CLI (`es.exe`)**, which the choco package does not ship. It is a separate download from [voidtools.com](https://www.voidtools.com/downloads/) — for x64, `ES-1.1.0.37.x64.zip`.

Query form:

```
es.exe -r "\.md$" <root>
```

---

## Results — CI synthetic tree (2,000 `.md` files)

Median of 3 runs. All three OSes in the same GH Actions matrix run (`24823979280`).

| Method                     | **Linux** (ubuntu-latest) | **macOS** (macos-latest) | **Windows** (windows-latest) |
|----------------------------|--------------------------:|-------------------------:|-----------------------------:|
| `Path.rglob('*.md')`       |                  10.04 ms |                 17.51 ms |                     31.00 ms |
| `os.walk` pruned           |                **3.37 ms**|               **4.42 ms**|                  **16.00 ms**|
| OS-native walker           |          3.92 ms (`find`) |         9.22 ms (`find`) |      437.00 ms (`Get-ChildItem`) |
| OS-native index            |       99.56 ms (plocate)  |       41.26 ms (mdfind)  |         110.00 ms (Everything) |
| Index result accuracy      |               2000 / 2000 |          **1485 / 2000 ⚠️** |                  2000 / 2000 |

## Results — local macOS at real scale

Same four methods, three real roots on a dev machine with a fully warm Spotlight index:

| Root                    | Dirs (approx.) | `rglob`      | `os.walk` pruned | `find`        | **`mdfind`** |
|-------------------------|---------------:|-------------:|-----------------:|--------------:|-------------:|
| `flowpad-oss`           |        ~8.5 k  |      212 ms  |          12 ms   |      342 ms   |      99 ms   |
| `~/Documents/dev`       |        ~131 k  |   12,063 ms  |         250 ms   |   19,316 ms   |     353 ms   |
| `~`          |       ~1.35 M  |   85,336 ms  |      54,710 ms   |  115,194 ms   |  **484 ms**  |

File counts differ across methods because each sees a different tree: pruned `os.walk` skips noise dirs, `mdfind` only sees Spotlight-covered files, `rglob`/`find` see everything. For the `~` row: `rglob`/`find` found 55,448 `.md` files; `os.walk` pruned found 15,934; `mdfind` found 28,315.

---

## What works

- **Pruned `os.walk` is the fastest method at small/sane scale on every OS**. A few milliseconds for a 2 K-file codebase-sized tree. The OS indexes add 7–30x overhead at this scale.
- **`mdfind` works on macOS** and is the fastest method by far once the tree is M-scale. At 1.35 M dirs it is **113x faster than pruned `os.walk`** and 177x faster than `rglob`.
- **`plocate` works on Linux** once you set up `updatedb` per root and query with trigram substring matching. `--basename '*.md'` returns zero hits — use `.md` as a substring probe instead and filter the suffix in the caller.
- **Everything works on Windows** once both the service and the standalone `es.exe` CLI are present.

## What didn't work (and why)

- **`choco install es`** — no such package; the correct chocolatey package is `everything`.
- **`choco install everything` alone** — installs the service but not `es.exe`. The CLI has to be downloaded separately from voidtools.com (`ES-1.1.0.37.x64.zip` at time of writing).
- **First-try macOS Spotlight warm-up** (`sudo mdutil -i on "$RUNNER_TEMP" && sleep 10`) — returned 0 results on CI. The working combination on CI is explicit `mdimport <root>` plus 60 s wait, and **even then coverage is incomplete** (1485 / 2000 hits on the synthetic tree).
- **Linux `plocate --basename '*.md'`** — returned 0 results. plocate uses a trigram index and cannot evaluate glob patterns against basenames. Trigram substring queries like `.md` work; post-filter the suffix in Python.
- **Windows `powershell Get-ChildItem -Recurse`** — 437 ms subprocess tax. **Never shell out to PowerShell to walk a tree**; the cold-start alone dominates anything below ~100 k files. Use Python `os.walk` directly.

---

## Conclusions

1. **At codebase scale (<~100 k dirs under a root), pruned `os.walk` wins**. OS indexes are measurably slower here — the query setup and IPC overhead exceed the walk itself. For record discovery under `~/.flow/records`, under individual project roots, or under any bounded tree, `os.walk` is the right tool.

2. **Crossover is around ~100 k directories under the root**. Above that, OS indexes crush walkers by orders of magnitude. On this dev machine's `~` (1.35 M dirs), `mdfind` ran 113x faster than pruned `os.walk` and 238x faster than `find`.

3. **The slow bootstrap is not a walker-speed problem; it is a root-set problem.** The fix is to narrow what `iter_claude_project_paths()` returns (stop passing `/` and `$HOME` when JSONL `cwd` fields are corrupt) — not to swap the walker for an OS index. Walking a few codebase-sized roots at a few ms each is already faster than setting up and querying any OS index. (This fix has since landed: `iter_claude_project_paths()` now gates every decoded cwd through `is_valid_project_cwd()` (`flow_sdk/fs_store/path_utils.py`), which rejects protected paths — `/`, `$HOME`, and temp-dir descendants unless `include_temp` is passed — so they never reach the walker. The interim `_invalid_project_roots()` helper is gone.)

4. **If a future feature legitimately needs to scan `$HOME` or larger** (global file search, cross-project indexing), the OS-index route is appropriate, and the integration blueprint is above. The operational cost is real:
   - Linux requires an existing `updatedb` nightly (or a per-invocation build paid up front).
   - macOS requires Spotlight to have indexed the tree; `mdimport` + wait works but coverage can still be partial.
   - Windows requires the Everything service to be running and having finished its initial volume scan, plus the separately-installed `es.exe` CLI.

5. **`mdfind` is not a drop-in replacement for a walker**. It missed ~26% of files on CI (1485 / 2000) even after explicit `mdimport` and a 60 s wait, and in the local run under `~` it reported 28,315 files vs 55,448 from `rglob`. It is a **good-enough approximation** for "find the user-relevant markdown on this machine" but **not** a source-of-truth enumerator for records.

---

## Related code

- [`flow_sdk/fs_store/indexer/functions/_claude_projects.py`](../../flow_sdk/fs_store/indexer/functions/_claude_projects.py) — `_real_path_from_jsonl`, `decode_claude_project_dir`, `iter_claude_project_paths` (which now filters the contaminated `/` and `$HOME` roots through `is_valid_project_cwd`). The source of the scan roots that made the bootstrap slow.
- [`flow_sdk/fs_store/operations/markdown_dirs.py`](../../flow_sdk/fs_store/operations/markdown_dirs.py) — `_find_docs_subdirs`, `doc_search_dirs` (pruned `os.walk` capped at `_DOCS_WALK_MAX_DEPTH`, skipping `_WALK_IGNORED`). The bootstrap consumer that calls into the scan roots and walks each one. (Lifted out of the old `flow_sdk/fs_records/markdown_record.py`, which no longer exists.)
- [`flow_sdk/server/routes/bootstrap.py`](../../flow_sdk/server/routes/bootstrap.py) — the route whose 57 s latency triggered this investigation.
- [`scan-and-discovery.md`](./scan-and-discovery.md) — the broader record-discovery doc; this file is a performance-focused addendum to it.
