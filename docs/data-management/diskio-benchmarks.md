---
id: b548a40c-c261-55e5-b5b4-fed90fdd6bc6
---
# diskio — measured results

What the `flow_sdk/diskio` work changed, in numbers taken on the finished branch. Design-time
measurements of thirteen candidate pieces (most of which stay Python) are in
[diskio-design-benchmarks.md](diskio-design-benchmarks.md); the interfaces are in
[diskio.md](diskio.md).

## How this was measured

- **Three variants, same machine, same run:** *base* = the commit the branch started from
  (`9199c51e2`); *python* = this branch with `FLOWPAD_DISKIO_BACKEND=python` (the default);
  *rust* = this branch with `FLOWPAD_DISKIO_BACKEND=rust`.
- **Interleaved and rotated.** Each round runs all three variants, and the order rotates every
  round, so no variant always runs first. The machine was shared with other work the whole time
  (load average 16–20 on 14 cores), so a single before/after reading would be noise; the
  rotation is what makes the ratios trustworthy. Operations the branch did not touch come out
  at 0.95–1.05x, which is the noise floor to read the other rows against.
- **Medians**, one warm-up round discarded. Micro operations: 6–9 rounds. End-to-end index: 4.
- **Public entry points only** (`gitignore_walk`, `FSIndexer.scan/index`, the markdown
  `from_disk_fn`, `read_document_bytes`, `scan_tree`, `GitRepo.get_status`, …), so the same
  harness measures every variant.
- **Corpora:** the main checkout (1,232 directories / 8,661 files after gitignore; 9,032 / 50,077
  with the denylist only); `~/Documents/dev` (29,602 directories / 120,748 files); a COPY of one
  instance's record store (63,256 records); read-only session transcripts.
- Date 2026-10-10, Apple Silicon, Python 3.11.

## Results

| Operation | base | python | rust | python vs base | rust vs base |
|---|---:|---:|---:|---:|---:|
| Tree walk, project, gitignore on (`gitignore_walk`) | 392 ms | 437 ms | **112 ms** | 0.9x | **3.5x** |
| Tree walk, `~/Documents/dev`, gitignore on | 6,839 ms | 7,146 ms | **2,153 ms** | 1.0x | **3.2x** |
| Tree walk, project, gitignore OFF (48k files) | ~320 ms | ~330 ms | same as python (stays in-process) | 1.0x | 1.0x |
| Project scan, server warm (`FSIndexer.scan`) | 274 ms | 280 ms | **106 ms** | 1.0x | **2.6x** |
| Project scan, first call in a fresh process | 1,024 ms | 936 ms | 696 ms | 1.1x | 1.5x |
| Docs-tree hash of a project (`scan_tree`) | 497 ms | 499 ms | **133 ms** | 1.0x | **3.7x** |
| Markdown parse, 233 documents (`from_disk_fn`) | 465 ms | **185 ms** | 183 ms | **2.5x** | 2.5x |
| Skill parse, 75 skills | 108 ms | **60 ms** | 61 ms | **1.8x** | 1.8x |
| Document read, 1,945 files (`read_document_bytes`) | 1,222 ms | **943 ms** | 846 ms | **1.3x** | 1.4x |
| Git status with line counts | 260 ms, 5 spawns | **227 ms, 1 spawn** | 181 ms | 1.15x | — |
| Git status, dirty tree with untracked files | 8 spawns | **2 spawns** | 2 | — | — |
| Protected-path check (`is_protected_path`) | 145 µs | **44 µs** | 44 µs | **3.3x** | — |
| Project-cwd check (`is_valid_project_cwd`) | 249 µs | **71 µs** | 71 µs | **3.5x** | — |

End to end, one real project (271 records) into a fresh database:

| Operation | base | python | rust | rust vs base |
|---|---:|---:|---:|---:|
| Full index, cold database | 3,244 ms | 3,352 ms | 2,982 ms | 1.09x |
| Re-index, nothing changed | 454 ms | 468 ms | **318 ms** | **1.43x** |
| Scan only (discovery) | 266 ms | 274 ms | **110 ms** | **2.4x** |

Unchanged, as expected (the branch does not touch them): shadow-store enumeration, the
freshness probe, pending-per-type, both session-stats parsers, wiki-link parsing — all within
0.9–1.05x.

## What a user feels

- **Opening or re-scanning a project is 2.5x faster with the switch on** (the scan), and a
  re-index of an unchanged project is about 1.4x faster. The larger the tree, the bigger the
  gain: the walk itself is 3–3.5x faster and that ratio held from 1,200 to 30,000 directories.
- **With no switch at all, parsing is faster**: markdown documents 2.5x, skills 1.8x. This is
  the Python-side work (one read per file instead of four, the C YAML loader, no per-file
  re-listing of the Claude projects folder).
- **The Git panel asks the machine less**: one process per poll instead of five (two instead of
  eight on a dirty tree). Locally that is 15% of the wall time; on a remote compute node it is
  the round trips.
- **A first full index is NOT meaningfully faster** (about 9%). Its time is the database side —
  rows, full-text search, link edges — which this work deliberately leaves alone.

## What did not improve, and why

- **Walking with gitignore off** stays on the in-process Python walk even with the switch on.
  Measured: with nothing to match, the walk is bounded by directory reads, and shipping 48,000
  file names across the process boundary made the Rust path up to 2.7x SLOWER (about 900 ms
  against about 330 ms). So the switch routes a walk to Rust only where `.gitignore` matching is
  the cost.
- **Small trees** (tens of directories) are a few milliseconds slower under Rust: one process
  spawn costs about 8 ms. The answer is identical either way.
- **Cold full index**: dominated by SQLite writes; see above.

## Correctness behind the numbers

Every row above was produced with identical results across variants: the project scan returns
the same refs (path, type, parent, scope, layout) on three real projects; the walk returns the
same sequence in twelve tree-and-mode combinations including a 294,777-directory pass-through
walk (measured before gitignore-off walks were kept in-process); a full index produces the same 271 entity rows and 271 search rows on base, python and
rust; and a live instance switched to Rust by the one preference re-indexed a project to the
same 239 rows, then re-parsed exactly the one file that was edited.

## The shadow-folder rename (migration `migration_2026_10_shadow_dir_rename`)

Run with `--apply` on a COPY of a real instance's record store (63,256 records):

| | before | after |
|---|---:|---:|
| record folders named `<type>-@<id>` | 41,173 | 1,574 |
| records found at the folder their id names | 23,657 | 62,556 |

39,599 folders renamed; 1,574 left in place because the bare folder already exists (the live
record — nothing is merged or deleted); 527 legacy folders held no `metadata.json` and were
skipped; 0 errors. A second run renames nothing. It is a correctness fix, not a speed one: a
record that cannot be found at its own id never finds its index sentinel, so it re-parses on
every run.
