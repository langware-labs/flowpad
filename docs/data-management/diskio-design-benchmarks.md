---
id: a21099b7-3e73-55bc-9de7-fff1dc898017
---
# Benchmark results (FIXED unless a benchmark is rerun)

13 independent units, each: Python SDK path measured in-process, a throwaway Rust CLI built in
the scratchpad, output parity checked against Python, timings as medians. All Rust code lives
under `scratchpad/<unit>/`; nothing in the repo was touched. Machine: Apple Silicon Mac, 14
cores. **Caveat on absolutes:** the 13 agents ran concurrently (load average 15-31), so wall
times are inflated by up to ~3x; ratios held on quieter spot runs where taken. Python peak RSS
is the whole bench process (flow_sdk imported, baseline ~45-90 MB); Rust RSS is the child alone.

## Consolidated verdict

| Unit | Parity | Rust vs Py in-process | Rust vs Py as subprocess | Verdict |
|---|---|---|---|---|
| Gitignore matching, 50k paths | exact; also vs `git check-ignore` | 23x | 7x | strong |
| Walk with gitignore (repo / dev tree) | exact | 13x / 8x | 10x / 7x | strong; 1.5x without gitignore (readdir-bound) |
| Codex session stats, 2.8 GB | exact, 28 keys | 3.6x serial, 33x rayon | 30x rayon | strong |
| Wiki-link / title parse, 52 MB | exact | 12x | 5x | strong, every regex hand-ported |
| VFS parse / protected-path classify | exact | 11x / 7x | 4x / 7x | classify gap is a Python root cache |
| Shadow store (metadata / pending) | exact | 1.6x serial, 9x rayon | same | disk-bound; rayon is the win |
| Merkle doc tree | exact | 4-7x | 4-5x | inherits the walk win |
| Freshness probe, 5k records | exact | 3.5x | 3x | syscall-bound (glob 70%) |
| Frontmatter reader, 1,941 files | exact; YAML 1.1 vs 1.2 caveats | 2.6x | 2.4x | `CSafeLoader` alone 1.6x |
| Git status / numstat / introduced (gix) | 58/58, 58/58, 197/200 | 1.7x / 2.3x / 3.8x | 1.7x / 1.2x / 3.1x | spawn count is the cost; git runs on the compute node |
| realpath canonicalize | exact | 1.9x | 1.7x | lstat-bound; call it less |
| Zip extract / create / hash | exact incl. guards | 1.0x / 1.5x / 1.6x | 0.8x / 1.5x / 1.6x | no case |
| Declared asset scan | exact | 1.5-3.7x | 0.1-1.1x | too small to spawn for |
| Claude session stats, 2.5 GB | exact, 25 keys, 3 variants | 4.1x serial (6.7x simd), 26x rayon | same | strong |

## 1. Walk — `gitignore_walk` vs Rust (`ignore` crate matcher, hand-written stack)

| root | mode | dirs | files | Python ms | Rust e2e ms | Rust internal ms | speedup e2e | speedup internal | Py peak RSS | Rust peak RSS |
|---|---|---|---|---|---|---|---|---|---|---|
| flowpad-oss checkout | gitignore=True | 1,223 | 8,583 | 391.1 | 37.9 | 29.5 | 10.3x | 13.2x | 47.8 MB (+2.9 over baseline) | 10.2 MB |
| flowpad-oss checkout | gitignore=False (denylist only) | 9,022 | 48,780 | 286.9 | 192.0 | 153.3 | 1.49x | 1.87x | 55.0 MB (+11.2) | 37.6 MB |
| ~/Documents/dev | gitignore=True | 25,905 | 94,607 | 4,519 | 638.4 | 562.1 | 7.1x | 8.0x | 55.1 MB (+10.8) | 54.6 MB |

Parity: identical yielded sequences in all 7 comparisons (repo and syncmd × default / --no-gitignore / --no-files, plus the full dev tree). `WalkBuilder` NOT used (it honors cross-file `!` re-includes Python does not); the crate is only the per-file matcher. Unexercised differences: unparseable pattern lines (pathspec aborts, `ignore` drops the line), non-UTF-8 .gitignore content, non-UTF-8 filenames. Reproduced oddities: denylist basenames also drop FILES named `build`/`dist`; worktrees check scans the full absolute path; root basename participates in `.claude` force-include; unreadable dir yielded with empty lists. Crates: ignore 0.4.33, serde, serde_json. 231 lines. Path: `scratchpad/walk/`.

## 2. Gitignore matching — `is_ignored` over a stack vs Rust

| Variant | Candidates | Stack build ms | Match ms | ns/path | Speedup (match) | Peak RSS |
|---|---|---|---|---|---|---|
| Python in-process (`is_ignored` over `_discover_gitignores` stack) | 50,000 | 147 | 1,999 | 39,980 | 1.0x | 112 MB |
| Rust e2e (spawn + discovery + stdin/stdout) | 50,000 | incl. | 287 total | 5,745 | 7.0x | 3.7 MB |
| Rust in-memory match only | 50,000 | 132 | 86.7 | 1,735 | 23x | 18.8 MB |

Parity: 0 disagreements on the 50k sample and on the full 287,823-entry raw walk. Three-way vs `git check-ignore --no-index`: Python and Rust diverge from git in the SAME 131 paths, all by design (117 `.claude` force-include, 14 `.flow` denylist). Negation untested by data (this repo's honored .gitignores produce no negation-decided paths). Stack build is syscall-bound on both sides. Crates: ignore 0.4, libc. 211 lines. Path: `scratchpad/ignore_match/`.

## 3. Declared asset scan — `scan_declared` / `scan_repo_tree` vs Rust (declarations exported as JSON)

| root / scan | variant | types | candidates | ms | speedup | peak RSS |
|---|---|---|---|---|---|---|
| repo declared (real_project_cwd) | Python in-process | 5 | 71 | 3.14 | 1.0x | 63 MB |
| repo declared | Rust e2e | 5 | 71 | 14.94 | 0.2x | 1.9 MB |
| repo declared | Rust internal (first / warm) | 5 | 71 | 2.18 / 1.56 | 1.4x / 2.0x | 1.9 MB |
| repo repo_tree | Python | 30 | 8 | 0.57 | 1.0x | 63 MB |
| repo repo_tree | Rust e2e | 30 | 8 | 10.54 | 0.1x | 1.9 MB |
| repo repo_tree | Rust internal | 30 | 8 | 0.64 / 0.27 | 0.9x / 2.1x | 1.9 MB |
| system declared (system_root) | Python | 2 | 39 | 0.78 | 1.0x | 63 MB |
| system declared | Rust e2e | 2 | 39 | 8.61 | 0.1x | 1.9 MB |
| system declared | Rust internal | 2 | 39 | 0.56 / 0.50 | 1.4x / 1.6x | 1.9 MB |
| system repo_tree | Python | 30 | 150 | 17.79 | 1.0x | 63 MB |
| system repo_tree | Rust e2e | 30 | 150 | 16.14 | 1.1x | 2.1 MB |
| system repo_tree | Rust internal | 30 | 150 | 6.91 / 7.42 | 2.6x / 2.4x | 2.1 MB |
| home declared (user_home_folder, markdown skipped) | Python | 7 | 129 | 1.65 | 1.0x | 63 MB |
| home declared | Rust e2e | 7 | 129 | 9.61 | 0.2x | 2.1 MB |
| home declared | Rust internal | 7 | 129 | 1.14 / 0.78 | 1.4x / 2.1x | 2.1 MB |
| synthetic fixture declared | Python | 8 | 17 | 1.19 | 1.0x | 63 MB |
| synthetic fixture declared | Rust e2e | 8 | 17 | 8.22 | 0.1x | 2.1 MB |
| synthetic fixture declared | Rust internal | 8 | 17 | 1.65 / 0.80 | 0.7x / 1.5x | 2.1 MB |
| synthetic fixture repo_tree | Python | 30 | 12 | 1.55 | 1.0x | 63 MB |
| synthetic fixture repo_tree | Rust e2e | 30 | 12 | 8.87 | 0.2x | 2.1 MB |
| synthetic fixture repo_tree | Rust internal | 30 | 12 | 0.59 / 0.42 | 2.6x / 3.7x | 2.1 MB |

Python registry bootstrap 638 ms excluded. Parity: identical candidates (path, type_name, layout, order) and issue messages on all roots and a synthetic fixture (recursive rglob ordering, glob mounts, symlinked mounts, AppleDouble, MAIN_FILE roots, retired mains/families, singleton, nested agentic-assets, symlink cycle guard). Declarations exported cleanly as data (shape, walks with RESOLVED mounts, singleton, retired_*). Had to re-implement by hand: pathlib suffix rule, sort-by-parts order, rglob not following symlinked dirs, dotfile globbing, `mount_matches`, `first_seen` keying, issue message templates. **Python bug found:** `scanning.py:212` positional `AssetScanIssue` → TypeError. `repo_tree` does NOT skip AppleDouble (reproduced). 506 lines. Path: `scratchpad/declared_scan/`.

## 4. Frontmatter reader — `read_document_bytes` vs Rust (serde_yaml + sha2 asm)

Corpus: 1,941 *.md, 19.5 MB, 1,139 with frontmatter, 12 with capsule blocks.

| variant | files | MB | ms total | µs/file | speedup | peak RSS MB |
|---|---|---|---|---|---|---|
| a) Python read_document_bytes (pure-Python SafeLoader) | 1,941 | 19.5 | 273.7 | 141.0 | 1.00x | 63 |
| b) Python + yaml.CSafeLoader | 1,941 | 19.5 | 172.7 | 89.0 | 1.58x | 71 |
| c) Rust via subprocess + json.loads per line | 1,941 | 19.5 | 114.7 | 59.1 | 2.39x | 78 (py side) |
| d) Rust internal | 1,941 | 19.5 | 106.1 | 54.7 | 2.58x | 10 |

Rust stage split of (d): read 24 ms, header split + YAML 29 ms, capsule scan 29 ms, sha256 11.5 ms, JSON out 12 ms. sha2 needs the `asm` feature to match OpenSSL. Parity on the real corpus: 0 mismatches on fields, body_start_line, revision, body sha256, error presence. `read_document_bytes` only catches ValueError; MalformedCapsuleError/DuplicateCapsuleError/UnicodeDecodeError propagate (mirrored). Synthetic 23-file edge set: all agree on error presence and body/line; **scalar typing differs** (PyYAML = YAML 1.1): yes/no/on/off → bool vs string; `012` → 10 vs string; `1_000` → 1000 vs string; `1:30` → 90 vs string; `.inf` → inf vs string; `1e3` → STRING in PyYAML but float in Rust; dates/timestamps → datetime vs string; merge keys `<<` flattened vs literal. None of these forms occur in the real corpus. Crates: serde_yaml 0.9.34 (deprecated), serde_json, sha2+asm. 224 lines. Path: `scratchpad/header/`.

## 5. Wiki links / markdown text — `parse_links`, `MarkdownDocument.from_text` vs Rust

Corpus: 6,420 *.md, 52.22 MB, 5,280 links; synthetic = 50 largest concatenated, 7.7 MB.

| unit | variant | files | MB | links | ms | MB/s | speedup | peak RSS MB |
|---|---|---|---|---|---|---|---|---|
| parse_links | Python parse-only [corpus] | 6,420 | 52.22 | 5,280 | 996.4 | 52.4 | 1.0x | 307 |
| parse_links | Python read+parse [corpus] | 6,420 | 52.22 | 5,280 | 966.7 | 54.0 | 1.0x | 307 |
| parse_links | Rust e2e subprocess [corpus] | 6,420 | 52.22 | 5,280 | 194.2 | 268.9 | 5.1x | 27 |
| parse_links | Rust internal parse-only [corpus] | 6,420 | 52.22 | 5,280 | 85.2 | 612.7 | 11.7x | 72 |
| parse_links | Python parse-only [synthetic] | 1 | 7.70 | 16 | 156.3 | 49.3 | 1.0x | 356 |
| parse_links | Rust e2e [synthetic] | 1 | 7.70 | 16 | 49.7 | 154.9 | 3.1x | 72 |
| parse_links | Rust internal [synthetic] | 1 | 7.70 | 16 | 27.9 | 275.9 | 5.6x | 72 |
| from_text | Python parse-only [corpus] | 6,420 | 52.22 | 969 | 420.7 | 124.1 | 1.0x | 379 |
| from_text | Python read+parse [corpus] | 6,420 | 52.22 | 969 | 607.0 | 86.0 | 0.7x | 379 |
| from_text | Rust e2e [corpus] | 6,420 | 52.22 | 969 | 183.6 | 284.4 | 2.3x | 72 |
| from_text | Rust internal [corpus] | 6,420 | 52.22 | 969 | 35.5 | 1,469 | 11.8x | 72 |
| from_text | Rust internal [synthetic] | 1 | 7.70 | 0 | 3.7 | 2,099 | 14.9x | 72 |

Parity: 0 mismatching files (ordered link lists with raw, line, wiki_ref, canonical; title; wiki_links; frontmatter dict). Not ported 1:1 (hand-written scanners, Python backtracking order reproduced): fence regex backreference `([`~]{3,})…^\1`, md-link negative lookahead `(?!https?://)` with resume-at-start+1, wiki negative lookbehind `(?<!\!)`, frontmatter and H1 regexes' newline-spanning `\s*` backtracking; Python `\s`/strip include \x1c-\x1f. `assets/types/markdown_document.py::parse_markdown_text` NOT ported (time cap). Crates: regex 1.11, serde_json (arbitrary_precision), percent-encoding. 633 lines. Path: `scratchpad/wiki/`.

## 6. Freshness probe — `FSRecord.index_required` path vs Rust (blake2)

5,000 synthetic shadow dirs under a redirected records root (built with the SDK's own `record_hash`), pointing at real repo files; 3,000 file kind, 1,000 entity_doc, 1,000 manifest; 2,500 fresh / 2,500 stale across 6 states.

| variant | probes | ms total | µs/probe | speedup vs Python full | peak RSS |
|---|---|---|---|---|---|
| Python `fingerprint` only (stat + format) | 5,000 | 10.2 | 2.0 | 30.3x | 97 MB |
| Python `record_hash` (registry lookup + per-type token + blake2b, no glob) | 5,000 | 158.6 | 31.7 | 2.0x | 97 MB |
| Python sentinel glob only (`_indexed_parts`) | 5,000 | 254.5 | 50.9 | 1.2x | 97 MB |
| Python full `index_required` | 5,000 | 309.7 | 61.9 | 1.0x | 97 MB |
| Rust e2e (spawn + stdin + json.loads) | 5,000 | 101.1 | 20.2 | 3.1x | 3 MB |
| Rust internal (parse + stat + glob + blake2b + JSON out) | 5,000 | 88.4 | 17.7 | 3.5x | 3 MB |
| Rust internal `--no-output` | 5,000 | 89.5 | 17.9 | 3.5x | 3 MB |

Parity: 0 mismatches on token, content_digest, path_digest, sentinel stem, index_required. Formats matched: content_digest = blake2b(digest_size=8) hex of token; path_digest = blake2b-8 of `str(asset_ref._path)`; file token `f"{st_mtime_ns}:{st_size}"`; entity_doc token `str(float(sum(mtime_ns+size over [root/<type>.json, root/<body>.md])))`; manifest token same over [asset, asset/<main>] — Python float `repr` exponent form (`3.582678104441483e+18`) needed a `py_float_repr` emulation. Rust cost split: JSON parse 2.0 µs, stat 3.4 µs, shadow-dir read_dir glob 14.6 µs (70%), two blake2b 1.7 µs. Crates: blake2, serde, serde_json. 181 lines. Path: `scratchpad/stamps/`.

## 7. Shadow store enumeration — `FSRecord.discover` family vs Rust

Store (`~/.flow/instances/oss/records`, READ-ONLY): 98 type dirs, 63,256 records, 486 MB of metadata.json, 24,085 sentinels (52,868 records have none). Top types: markdown 9,566, annotation 8,021, claude_session 7,944, flow_message 6,888, workspace 4,398. **41,173 record dirs carry the legacy `<type>-@<uuid>` name** while metadata `id` is the bare uuid.

| unit | variant | types | records | ms | speedup | peak RSS |
|---|---|---|---|---|---|---|
| 1 ids (`_discover_records_dir_ids`) | Python | 98 | 63,256 | 484 | 1.0x | 56 MB |
| 1 ids | Rust e2e | 98 | 63,256 | 311 | 1.6x | 18 MB |
| 1 ids | Rust internal | 98 | 63,256 | 288 | 1.7x | 18 MB |
| 2 meta (`discover`, field counts) | Python | 98 | 63,256 | 15,321 | 1.0x | 941 MB |
| 2 meta | Rust e2e | 98 | 63,256 | 9,800 | 1.6x | 104 MB |
| 2 meta | Rust rayon e2e | 98 | 63,256 | 1,730 | 8.9x | 122 MB |
| 2 meta | Rust rayon internal | 98 | 63,256 | 1,651 | 9.3x | 122 MB |
| 3 sentinels (`_indexed_parts` + `indexed_at`) | Python | 98 | 63,256 | 18,046 | 1.0x | 119 MB |
| 3 sentinels | Rust e2e | 98 | 63,256 | 9,141 | 2.0x | 75 MB |
| 4 pending (`type_has_pending_changes`, short-circuit) | Python | 98 | 63,256* | 7,488 | 1.0x | 77 MB |
| 4 pending | Rust e2e | 98 | 63,256* | 2,013 | 3.7x | 7 MB |
| 4 pending | Rust rayon e2e | 98 | 63,256* | 943 | 7.9x | 13 MB |

*short-circuits at the first pending record per type (46 of 98 types pending). Units 2-4 are disk-bound (`find | xargs cat` of all metadata = 11 s wall / 7.5 s sys); rayon wins by overlapping syscalls. Parity: ids identical for all 98 types; field counts 0 mismatches; sentinel tuples + indexed_at 0 mismatches. Key subtlety: Python looks the sentinel up at `records_root/<type>/<metadata id>/`, NOT the enumerated dir, so legacy-named dirs land on a non-existent folder → None → pending; Rust mirrors it. Per-record `index_required`: 606 mismatches, ALL in the 12 types with bespoke `asset_hash_fn` not ported (task 347, skill 84, whiteboard 82, …); 6 `orphan` diffs from a sibling agent's temp files. Formats: as in unit 6; path digest here over `str(Path(asset_ref).resolve())`; indexed_at = `datetime.fromtimestamp(epoch, utc).isoformat()`. Per-type hash kind + main/body names came from a hints.json exported from SchemaRegistry. Crates: serde, serde_json, rayon, blake2. 309 lines. Path: `scratchpad/shadow/`.

## 8. Codex session stats — `_parse_codex_jsonl_stats` vs Rust (serde_json streaming)

Corpus: 1,440 jsonl under `~/.codex/sessions`, 2,819 MB, largest 402 MB. No git side-calls; one `stat` per file (included both sides).

| Variant | files | MB | seconds (median of 3) | MB/s | speedup | peak RSS MB |
|---|---|---|---|---|---|---|
| Python in-process | 1,440 | 2,819 | 33.68 | 84 | 1.0x | 217 |
| Rust serial e2e (spawn + json.loads/line) | 1,440 | 2,819 | 9.46 | 298 | 3.6x | 102 |
| Rust serial internal | 1,440 | 2,819 | 9.28 | 304 | 3.6x | 102 |
| Rust rayon e2e | 1,440 | 2,819 | 1.11 | 2,534 | 30.3x | 166 |
| Rust rayon internal | 1,440 | 2,819 | 1.00 | 2,808 | 33.5x | 166 |

Load avg ~31 during the run; quieter single shot: Python 11.0 s, Rust serial 3.9 s (2.9x), rayon 0.68 s (16x). Parity: 0 mismatches on all 28 keys after one fix (`approval_policy` dict → Python `str(dict)` repr; fixed with preserve_order + py_repr fallback). Edge cases handled: universal newlines, `str.strip` incl. \x1c-\x1f, code-point slices `[:200]`/`[:500]`, Python truthiness, `str()` of scalars, `int(x or 0)`, `modified_at` reproducing CPython's `fromtimestamp` → round-half-even µs → naive local isoformat. Unhit divergences: NaN/Infinity, lone surrogates, invalid UTF-8 (Python crashes, Rust skips the line), non-object lines, duplicate keys. Design: typed `Raw`/`Payload`/`Item` structs with `IgnoredAny` for unused fields; `read_until(b'\n')` into a reused Vec; rayon `par_iter` over files. Crates: serde, serde_json (preserve_order), rayon, chrono. 356 lines. Path: `scratchpad/codex/`.

## 9. Claude session stats — `_parse_jsonl_stats` vs Rust (serde_json typed / Value / simd-json, rayon)

Corpus: 1,709 jsonl under `~/.claude/projects` (2.51 GB); 1,691 "stable" files used for parity and timing (18 files were being appended to by live sessions during the run and were excluded). Largest file 168 MB. Three Rust variants: typed serde structs with `IgnoredAny` for unused fields; untyped `serde_json::Value`; typed `simd-json`.

| set | variant | files | GB | seconds (median of 3) | MB/s | speedup vs Python | peak RSS MB | Rust internal s |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| full | Python in-process | 1,691 | 2.51 | 28.60 | 88 | 1.00x | 186 | — |
| full | Rust typed serde_json, 1 thread (subprocess e2e) | 1,691 | 2.51 | 6.96 | 360 | 4.11x | 62 | 6.65 |
| full | Rust typed serde_json, rayon 14 threads (e2e) | 1,691 | 2.51 | 1.08 | 2,313 | 26.4x | 114 | 0.94 |
| full | Rust Value serde_json, 1 thread (e2e) | 1,691 | 2.51 | 9.41 | 266 | 3.04x | 91 | 9.29 |
| full | Rust typed simd-json, 1 thread (e2e) | 1,691 | 2.51 | 4.26 | 588 | 6.72x | 99 | 4.11 |
| largest | Python in-process | 1 | 0.17 | 0.41 | 413 | 1.00x | 94 | — |
| largest | Rust typed serde_json, 1 thread (e2e) | 1 | 0.17 | 0.12 | 1,383 | 3.35x | 9 | 0.11 |
| largest | Rust Value serde_json, 1 thread (e2e) | 1 | 0.17 | 0.32 | 530 | 1.28x | 24 | 0.30 |
| largest | Rust typed simd-json, 1 thread (e2e) | 1 | 0.17 | 0.16 | 1,031 | 2.50x | 30 | 0.15 |

Load caveat as everywhere: Python rounds were 28.6 / 33.6 / 9.5 s (the third round ran on a quieter box); the ratios held per round (Rust typed 2.0 s, rayon 0.34 s in that round). Parity (supervisor re-ran `compare.py` on 2026-10-10 13:45): **ALL 25 KEYS MATCH on 1,691 files for all three Rust variants** (floats at 1e-9 rel). Rust reported 0 bad JSON lines and 0 bad UTF-8 lines on the corpus. Typed structs beat `Value` by 1.35x (skipping unused fields is the win); simd-json beats typed serde_json 1.6x single-threaded. Crates: serde, serde_json, simd-json 0.13 (runtime-detection), rayon, chrono. 813 lines (the three variants share one file). Path: `scratchpad/sessions/` (bench_table.md, bench_log.txt, compare.py, rs/).

## 10. Merkle doc tree — `scan_tree` vs Rust (sha2 + ignore + rayon)

| root | variant | folders | files | MB read | ms | speedup | peak RSS MB |
|---|---|---|---|---|---|---|---|
| docs | Python scan_tree | 17 | 180 | 2.7 | 130.0 | 1.0x | 52 |
| docs | Rust sequential e2e | 17 | 180 | 2.7 | 27.5 | 4.7x | 5 |
| docs | Rust sequential internal | 17 | 180 | 2.7 | 19.6 | 6.6x | 5 |
| docs | Rust rayon e2e | 17 | 180 | 2.7 | 44.4 | 2.9x | 7 |
| checkout | Python scan_tree | 1,223 | 742 | 5.1 | 636.6 | 1.0x | 54 |
| checkout | Rust sequential e2e | 1,223 | 742 | 5.1 | 154.9 | 4.1x | 16 |
| checkout | Rust sequential internal | 1,223 | 742 | 5.1 | 143.7 | 4.4x | 16 |
| checkout | Rust rayon e2e | 1,223 | 742 | 5.1 | 132.4 | 4.8x | 18 |
| checkout | Rust rayon internal | 1,223 | 742 | 5.1 | 121.9 | 5.2x | 18 |

Load avg 21-25; idle spot runs: docs Rust sequential ~13 ms, rayon ~4.5 ms (the rayon-slower docs row is contention). On the checkout Rust time is the gitignore walk (~100-300 ms); hash/tree phase ~110 ms sequential, ~14 ms rayon. Parity: 0 mismatches on both roots (own_hash, inputs_hash, existing_hash, manual, ground_truth, has_index, index_title; content_hash, title, is_folder_note, wiki_links; set equality). Hash inputs matched byte for byte: own_hash = sha256("template_version=1\n" + "prompt_version=1\n" + per file sorted (name, hash): `file\0<name>\0<hex>\n`); inputs_hash = sha256(`own\0<own_hex>\n` + per child sorted: `child\0<name>\0<hex>\n`); content_hash = sha256(raw bytes); folder note (stem == parent dir name, case-insensitive) excluded from own_hash; index.md excluded by name; .md/.mdx case-insensitive. Title/frontmatter/wiki regexes hand-rolled (regex-crate captures over whole 60 KB files cost ~50 ms/root). Lenient YAML-ish index.md parser ported. Crates: sha2, regex, serde, serde_json, ignore 0.4, rayon, libc. 662 lines. Path: `scratchpad/merkle/`.

## 11. Paths — `canonical_posix_path`, VFS parse, `is_protected_path` family vs Rust

| unit | variant | inputs | ms | µs/item | speedup | peak RSS MB |
|---|---|---|---|---|---|---|
| canon | Python | 50,000 | 2,308.2 | 46.16 | 1.0x | 123 |
| canon | Rust e2e | 50,000 | 1,321.4 | 26.43 | 1.7x | 21 |
| canon | Rust internal (Python realpath algorithm mirrored: lstat+readlink per component) | 50,000 | 1,217.0 | 24.34 | 1.9x | 21 |
| canon | Rust std::fs::canonicalize (libc realpath) | 50,000 | 930.5 | 18.61 | 2.5x | 22 |
| vfs | Python | 20,000 | 89.6 | 4.48 | 1.0x | 262* |
| vfs | Rust e2e | 20,000 | 20.8 | 1.04 | 4.3x | 5 |
| vfs | Rust internal | 20,000 | 8.3 | 0.41 | 10.8x | 5 |
| classify | Python | 30,043 | 9,952.4 | 331.27 | 1.0x | 262* |
| classify | Rust e2e | 30,043 | 1,481.9 | 49.32 | 6.7x | 32 |
| classify | Rust internal | 30,043 | 1,392.3 | 46.34 | 7.1x | 32 |

Parity: canon 0/50,000 (libc canonicalize variant: 1 mismatch — dangling path, Python keeps unresolved tail); vfs 0/20,000 after fixing `\d` = Unicode Nd only (Rust `is_numeric` also accepts No/Nl); classify 0/30,043 (`ancestors_of` raises on embedded NUL while `is_protected_path` fails closed). Hard rules: Python non-strict realpath semantics; ntpath normpath + `PureWindowsPath.as_posix` + casefold on POSIX; pathlib parts on the RAW path vs policy key on the RESOLVED path; **`is_protected_path` re-resolves its ~6 roots on every call — that is most of the 331 µs; Rust read them once from a config** (a Python-side root cache would close most of the gap). canon is lstat-bound (~8 lstats/path); the lever for the 6,900 resolve() calls per index run is calling resolve fewer times. Crates: unicode-normalization, unicode-general-category, serde_json. 314 lines. Path: `scratchpad/paths/`.

## 12. Git — `GitRepo.get_status`/`_line_counts`, `git_assets_introduction` vs gix 0.89

Live dirty checkout, 58 status entries; load avg 15-20; ±30%.

| unit | variant | items | ms (median of 7) | speedup | peak RSS MB |
|---|---|---|---|---|---|
| status (+branch) | Python `GitRepo.get_status()` [2 git spawns via `sh -c`] | 58 | 75.0 | 1.0x | 86 |
| status (+branch) | bare `git status --porcelain=v1 --branch -uall` subprocess.run | 58 | 55.0 | 1.4x | 9 |
| status (+branch) | bare git status via asyncio shell (production shape) | 58 | 59.2 | 1.3x | — |
| status (+branch) | Rust gix e2e | 58 | 44.4 | 1.7x | 18 |
| status (+branch) | Rust gix internal | 58 | 43.6 | 1.7x | — |
| numstat HEAD→worktree (+untracked) | Python `_line_counts()` [6 spawns] | 58 | 117.2 (376 in run 1) | 1.0x | 87 |
| numstat | Python `get_status(line_counts=True)` [8 spawns = the Git panel call] | 58 | 210.4 (590 in run 1) | 0.6x | — |
| numstat | Rust gix e2e | 58 | 94.1 | 1.2x | 18 |
| numstat | Rust gix internal | 58 | 50.1 | 2.3x | — |
| introduced (200 paths) | Python `git_assets_introduction()` [ls-files + 1 log + 6×`log --follow`] | 200 | 756.3 | 1.0x | 87 |
| introduced | bare `git log --full-diff -M --name-status --diff-filter=AR -- …` | 200 | 159.8 | 4.7x | 86 |
| introduced | Rust gix e2e | 200 | 245.4 | 3.1x | 95 |
| introduced | Rust gix internal (rename follow) | 200 | 200.3 | 3.8x | — |
| introduced | Rust gix internal (--no-follow) | 200 | 115.2 | 6.6x | — |

Exact Python commands (all via `asyncio.create_subprocess_shell("cd <dir> && LC_ALL=C GIT_TERMINAL_PROMPT=0 … git …")` on the compute node): status = `git status --porcelain=v1 --branch --untracked-files=all` + `git ls-remote --get-url`; line counts = `rev-parse --verify -q HEAD`, `diff --numstat HEAD`, `ls-files --others --exclude-standard -z`, `rev-parse --absolute-git-dir`, then `GIT_INDEX_FILE=<gitdir>/flowpad-status-<uuid>.index` + `add -N --pathspec-from-file … --pathspec-file-nul` + `diff --numstat`; introduction = `ls-files`, `log --format=@%aI --full-diff -M --name-status --diff-filter=AR`, then per renamed path `log --follow --format=%aI --diff-filter=A`. Parity: status 58/58, numstat 58/58 (untracked counted directly, binary = NUL in first 8000 bytes), introduced 197/200 (3 Python-side artefacts: symlink outside repo → None; two files whose earlier add is hidden by git's history simplification). gix gaps: rename detection silently skipped at default `Rewrites.limit=1000` (fix `limit: 0`); no `--follow`; no ahead/behind helper; no worktree numstat (done via `gix::diff::blob`). gix status only ~1.3x faster than git itself; Python's overhead is shell + spawn. Crates: gix 0.89 (sha1, status, blob-diff, revision, max-performance-safe, parallel), serde, serde_json, anyhow. 452 lines. Path: `scratchpad/git/`.

## 13. Archive and hashing — `safe_extract_zip`, folder zip, `file_hash` vs Rust (zip crate, sha2 asm)

| unit | corpus | variant | entries | MB | ms | MB/s | speedup | peak RSS MB |
|---|---|---|---|---|---|---|---|---|
| extract | docs | Python | 220 | 3.37 | 65 | 52 | 1.00x | 37 |
| extract | docs | Rust e2e / internal | 220 | 3.37 | 69 / 63 | 49 / 53 | 0.93x / 1.02x | 5 |
| extract | flow_sdk | Python | 4,587 | 83.31 | 1,057 | 79 | 1.00x | 81 |
| extract | flow_sdk | Rust e2e / internal | 4,587 | 83.31 | 1,383 / 1,373 | 60 / 61 | 0.76x / 0.77x | 8 |
| zip | docs | Python | 220 | 3.37 | 80 | 42 | 1.00x | 81 |
| zip | docs | Rust e2e / internal | 220 | 3.37 | 60 / 56 | 56 / 60 | 1.32x / 1.43x | 6 |
| zip | flow_sdk | Python | 4,587 | 83.31 | 2,619 | 32 | 1.00x | 84 |
| zip | flow_sdk | Rust e2e / internal | 4,587 | 83.31 | 1,759 / 1,754 | 47 / 48 | 1.49x | 26 |
| hash | flow_sdk | Python | 4,587 | 83.31 | 231 | 360 | 1.00x | 84 |
| hash | flow_sdk | Rust e2e / internal | 4,587 | 83.31 | 149 / 143 | 561 / 581 | 1.56x / 1.61x | 2 |

Extraction syscall-bound (Rust 0.35 s user / 0.93 s sys). Parity: extracted trees byte-identical; zip entry sets/order/sizes/CRCs identical (compressed bytes differ: miniz_oxide vs zlib); 4,587/4,587 hashes identical; hostile zip (`../evil`, symlink member) rejected by both before any write, same message; symlink-only zip: both skip the member. Guards mirrored: member cap 100,000, 4 GiB header-sum + streamed budget, backslash normalisation, `__MACOSX` skip, symlink skip via S_IFLNK, is_safe_rel_path, resolve-under-root with non-strict resolve, validate-all-before-write, unwrap_single_folder. `fs_actions.download_zip` is an unimplemented stub; unit 2 mirrors `_zip_bundle` / `copy_folder`. Crates: zip 2.4.2, sha2+asm, time, walkdir, libc, serde_json. 188 lines. Path: `scratchpad/archive/`.
