---
id: 7c3884f1-0581-5d94-9a65-7b2ed6b155a3
---

# Ignore-File-Aware Filesystem Walk (`.gitignore`, `.flowignore`)

Every tree walker in `flow_sdk` that recurses a real project directory shares one function: `gitignore_walk()` (`flow_sdk/fs_store/indexer/walk.py`). It is a generic pre-order DFS that yields one `(dir_path, subdirs, files)` tuple per surviving directory, applying a single skip policy so that the "what do we descend into" decision lives in exactly one place (`flow_sdk/fs_store/gitignore.py`) rather than being re-implemented by each consumer.

> **This is a discovery walk, not the indexer DFS.** `gitignore_walk()` walks raw directories on disk. The `FSIndexer` DFS (`docs/data-management/scan-and-discovery.md`) walks typed `FSRef` nodes and dispatches per-type parsers. The folder walker that bridges them (`project_folder_walker_fn`) is one consumer of `gitignore_walk()`.

---

## The walk

**Source:** `flow_sdk/fs_store/indexer/walk.py`

`gitignore_walk(root, *, gitignore=True, denylist=True, include_files=True)` is a pre-order (parent-before-children) depth-first traversal built on `os.scandir`. Its behavioral contract:

- **`os.scandir`, not `Path` methods.** Directory entries are read via `os.scandir`, which serves the dir/file/symlink type from the readdir cache — so the per-entry type checks cost no extra `stat` in the common case (unlike `Path.is_dir()` / `is_symlink()` / `is_file()`, which each syscall).
- **Symlinked directories are never followed.** A directory entry is treated as a subdirectory only when `entry.is_dir(follow_symlinks=False)` is true — a symlink pointing at a directory is not descended. Symlinks to regular files still count as files (`entry.is_file()` with `follow_symlinks=True`).
- **Unreadable directories are skipped, never fatal.** Any `OSError` from `scandir` or a per-entry stat drops that entry (or yields an empty listing for that dir); one bad directory (e.g. a `PermissionError` inside an unreadable mount) never aborts the walk.
- **The root is always yielded**, even when a pattern would match it — the caller asked for that tree. Filtering applies to entries *within* the root, not to the root itself.
- **No `os.walk`-style pruning contract.** The yielded `subdirs` list is informational; mutating it does not affect the walk. Entries within each yielded directory are sorted ascending by name.
- **The root is walked as given** — no `resolve()`. Callers that need a normalized root (e.g. to compute `relative_to` output) resolve it themselves before calling.

The three keyword flags select how much of the skip policy applies:

| Flags | Behavior |
|---|---|
| `gitignore=True` (default) | Full policy: denylist + `.flowignore` / `.gitignore` stack + `.claude/` force-include. |
| `gitignore=False, denylist=True` | Skip only the hardcoded denylist; ignore all `.gitignore` files. |
| `gitignore=False, denylist=False` | Pure pass-through — only symlink/unreadable skips. (The `FSIndexer`'s legacy `gitignore=False` behavior.) |
| `include_files=False` | Yield empty file lists and skip the per-file match cost — for folder-only consumers. |

---

## Three-stage skip

**Source:** `flow_sdk/fs_store/gitignore.py`

When `gitignore=True`, each entry passes through `is_ignored(path, is_dir, stack, root)`, which applies the policy in a fixed order.

### Stage 1 — the hardcoded denylist

`is_denylisted(path)` matches a path's **basename** against the `_WALK_IGNORED` frozenset, or detects an agent worktree (see below). This is a cheap fast-path consulted before any `.gitignore` is parsed, so a 50k-file `node_modules` collapses to a single decision instead of a recursive walk.

`_WALK_IGNORED` contains:

| Category | Entries |
|---|---|
| VCS / vendor | `.git`, `node_modules`, `.venv`, `venv` |
| Python build/cache | `__pycache__`, `.tox`, `dist`, `build`, `.eggs`, `.mypy_cache`, `.pytest_cache`, `.ruff_cache` |
| JS build/cache | `.next`, `.nuxt`, `coverage`, `.cache` |
| macOS junk | `__MACOSX` (holds only AppleDouble `._*` resource-fork sidecars) |
| Flowpad state dirs | `.flow`, `.flowpad`, `.markdown_index`, `.llm_index` (asset-local capsule metadata, llm_index summary caches, markdown-index sidecars, instance state — never content) |

`is_denylisted` is exported as a standalone predicate so walkers that want to skip generated/vendor dirs *without* honoring `.gitignore` can use it directly (this is what `gitignore=False, denylist=True` selects). Its sibling `is_under_denylisted_dir(path)` answers the same question for a path that was *stored* earlier and has no walk to ride along with — it checks every ancestor segment against `_WALK_IGNORED` (plus the worktree rule) as pure string work, so retention can apply the same policy discovery does over thousands of stored paths.

### Stage 2 — the ignore-file stack

The walk maintains a `GitignoreStack` — a list of `(folder, IgnoreFile)` pairs, one per ignore file (`.gitignore` or `.flowignore`) in the current ancestor chain:

- `load_gitignore_stack(root, flowignore=True)` seeds it with every `.flowignore` from `/` down to the root and with the root's `.gitignore`. A root one of those `.flowignore` files excludes is seeded with `EXCLUDE_ALL`, so nothing under it survives.
- As the DFS descends into a directory, `push_gitignore(stack, dir, flowignore=True)` pushes that directory's files and returns how many, so the frame knows how many to pop on backtrack.

Each file is matched **exactly as git matches it**: `flow_sdk/fs_store/ignore_rules.py` is a port of git's own `wildmatch.c` and the pattern rules of `dir.c` (on bytes, case-sensitive — git with `core.ignorecase=false`), and `tests/unit/diskio/test_ignore_files.py` uses `git ls-files` as the oracle. Within a file the last matching line wins; across files **the deepest file with a matching line decides**, so a child `!keep.md` re-includes what a parent `*.md` ignored. A walk never enters an excluded directory, so — as in git — nothing below one can be re-included, and its own ignore files are never read.

### Stage 3 — `.flowignore` before `.gitignore`

`.flowignore` uses gitignore syntax and says what Flowpad never indexes, scans or mints. `stack_ignores` asks the `.flowignore` files first: when one has a matching line it decides, ignore or keep — so `!reports/` brings a gitignored folder into the index. Only when no `.flowignore` speaks does the `.claude/` force-include and then the `.gitignore` stack decide. The denylist (stage 1) stays absolute: no ignore file brings back `node_modules`.

A walk only prunes what it visits, and many index walkers list files themselves (a folder's markdown, a memory folder's glob). So `FlowIgnore` (`flow_sdk/fs_store/gitignore.py`) answers the same `.flowignore` question for single paths, reading the files from `/` down, and four seams ask it:

| Seam | Where | Effect |
|---|---|---|
| Emitted refs | `FSIndexer.scan` (`index_function.py`, `kept`) | Every ref any walker emits is dropped when excluded. |
| Live resolve | `resolve_asset` (`fs_store/resolve.py`) | `NotAnAsset` — so a session's writes, `flow show` and `reindex_paths` never index or mint it. |
| Id writes | `TypeInfo.mint`, `reconcile`'s re-stamp | No id is ever written into an excluded file. |
| Orphans | `_source_gone_orphans`, asset-occurrence retention | A row whose file is now excluded leaves the index as a deleted file's does (on the next auto-index). |

`.flowignore` is not read by automation file triggers (`fsop_filters.py`), static serving or sharing — it governs the index only.

### Force-include of `.claude/`

**Source:** `_is_force_include` / `_is_claude_worktree` in `flow_sdk/fs_store/gitignore.py`

Paths whose ancestor chain (up to `root`) contains a basename in `_FORCE_INCLUDE` — currently just `.claude` — are **never ignored by a `.gitignore`**, even when `.claude/` is gitignored at the project root. A `.flowignore` still applies inside `.claude/`. This exists so project-level skills, agents, and commands under `.claude/` stay discoverable regardless of a repo's `.gitignore`.

The force-include has one deliberate carve-out: `_is_claude_worktree(path)` skips anything under `.claude/worktrees`. Agent isolation-mode git worktrees live there, and each is a **full repo copy** with thousands of files. Without the carve-out, the `.claude` force-include would pull every worktree's entire tree into a discovery walk, turning a single `markdown` scan into tens of thousands of duplicate files. The worktree skip is checked before the force-include, so it overrides it while the rest of `.claude/` is still traversed.

---

## The `IndexerOptions.gitignore` flag

**Source:** `flow_sdk/fs_store/indexer/index_function.py`

`IndexerOptions.gitignore` (default `True`) is the indexer-level toggle that flows into `gitignore_walk()`. It applies **only in project-scope walkers** — specifically the FOLDER fan-out (`project_folder_walker_fn`, registered on `REAL_PROJECT_CWD` / `CWD_ROOT`). It is a no-op for the user-home / system-root walks, which don't do a generic directory recursion.

Note how `project_folder_walker_fn` wires it: it passes `gitignore=opts.gitignore` **and** `denylist=opts.gitignore`. So setting `opts.gitignore=False` there produces a pure pass-through — even the hardcoded denylist is dropped (the `FSIndexer`'s legacy behavior), not just `.gitignore` honoring.

---

## Which implementation walks

`gitignore_walk` has two implementations behind one switch, `FLOWPAD_DISKIO_BACKEND`
(`python` by default; see [diskio.md](diskio.md)). With `rust`, a walk that honours
`.gitignore` is answered by the `flowpad-diskio-scan` binary through
`flow_sdk/diskio/stage1.py::stage1_items` — the same policy, the same order, the same
entries, verified complete before a single tuple is yielded. A walk with `gitignore=False`
always runs in-process: with nothing to match it is bounded by directory reads, and it measured
slower through the binary. Whenever Python would answer anyway — the default, no binary on this
platform, a failed stream — the descent described above runs unchanged.

## Consumers

Everything that recurses a real project tree routes through the shared walk:

| Consumer | Source | Notes |
|---|---|---|
| Project folder walker | `flow_sdk/fs_store/indexer/functions/project_folder_walker.py` | Emits one transient `FOLDER` `FSRef` per surviving directory (root included). Passes `include_files=False` (downstream FOLDER functions do their own file matching) and threads `opts.gitignore`. Before walking a root that sits in a tri-state protected folder (Documents/Desktop/Downloads) it probes one `os.scandir` read; a `PermissionError` there marks the folder `denied` (`special_folders.mark_denied`) and skips the root, so an OS refusal is recorded once instead of re-prompting on every scan. |
| Markdown-dirs discovery | `flow_sdk/fs_store/operations/markdown_dirs.py` (`walk_markdown_files`) | Collects the `.md` files inside `docs`/`doc` folders under a root (or all of them, when the root is one) as sorted relative POSIX paths. |
| llm_index Merkle scanner | `flow_sdk/llm_index/core.py` | Folds the pre-order walk into a post-order content-hash tree; the `gitignore` toggle honors `.gitignore` while the denylist always applies. |
| fsop watcher filter | `flow_sdk/server/fsop_filters.py` | Does **not** call `gitignore_walk()` — it runs its own bounded `os.walk` but reuses the matching primitives directly (`_WALK_IGNORED`, `load_gitignore_stack`, `push_gitignore`, `is_ignored_below` — an event inside an ignored folder is ignored) so its skip decisions match the shared policy. Reads `.gitignore` only. |
