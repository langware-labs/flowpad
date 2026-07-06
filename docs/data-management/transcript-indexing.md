---
id: 87b990d0-6d04-5289-851e-96306040e428
---

# Transcript Indexing

The **transcript indexer** is a second, opt-in indexing pass that runs *over* session transcripts rather than over records. Where the regular `FSIndexer` walks the filesystem and materializes one `Record`/`Entity` per file, the transcript indexer parses a session's JSONL transcript and routes the parsed entries to a set of registered handlers that produce *side effects* — cross-links, on-demand entity creation — without emitting any new child refs of their own.

It lives under `flow_sdk/fs_store/transcript_indexer/`.

## Naming Clarification

Do not confuse the two indexers:

| Name | Walks | Produces |
|------|-------|----------|
| **FSIndexer** (`flow_sdk/fs_store/indexer/index_function.py`) | The filesystem tree | One record/entity per matched file (`CLAUDE_SESSION`, `PLAN`, `SKILL`, …) |
| **TranscriptIndexer** (`flow_sdk/fs_store/transcript_indexer/indexer.py`) | The entries *inside* a session's JSONL transcript | Side effects only (cross-links, on-demand indexing) — returns `[]`, no child refs |

The transcript indexer is registered *as* one of the FSIndexer's per-node functions, so it runs as a stage of an FSIndexer walk (see [How and when it runs](#how-and-when-it-runs)).

## What it is

`TranscriptIndexer` (`flow_sdk/fs_store/transcript_indexer/indexer.py`) is an async `IndexerFunc`: it has the `async __call__(self, nodes, opts) -> list[FSRef]` signature the FSIndexer dispatches, and it is registered against the **`CLAUDE_SESSION`** (and, by the same mechanism, `CODEX_SESSION`) node type — the node whose `path` is a session's `.jsonl` transcript.

For each node it:

1. Maps the node's `record_type` to a worker type via `_WORKER_BY_RECORD_TYPE` — `CLAUDE_SESSION → "claude"`, `CODEX_SESSION → "codex"`. Any other record type is skipped (`_worker_type_for` returns `None`).
2. Parses the transcript into an `AgentTranscriptFile` (`flow_sdk/transcript_analyzer/transcript.py`).
3. Runs each registered handler over the parsed entries.

It always **returns `[]`** — it is side-effect-only and never contributes children to the walk. The class docstring is explicit about this: "Returns `[]` (side-effect only — no children)."

The dispatcher does *not* hand-roll its own matcher logic. Routing "piggybacks on `AgentTranscriptFile.filter()`", so all matcher logic lives in the analyzer rather than in the indexer.

### Opt-in, not in the default indexer

The transcript indexer is **not** wired into the production `build_default_indexer()` in `flow_sdk/fs_store/indexer/builtin.py`. That module notes: "Transcript handlers are opt-in (full-JSONL parse is expensive — see `flow_sdk/fs_store/transcript_indexer/`)." A full-transcript parse per session is costly, so a caller that wants it constructs a `TranscriptIndexer`, adds handlers, and registers it on `CLAUDE_SESSION` explicitly (see [How and when it runs](#how-and-when-it-runs)).

## Freshness

The transcript indexer has its **own** freshness check, `_is_fresh` (`flow_sdk/fs_store/transcript_indexer/indexer.py`), which is distinct from the FSIndexer's `.hash`-sentinel freshness.

`_is_fresh(jsonl_path, worker_type)` returns `True` — meaning "skip, nothing to reprocess" — iff the **session entity's `updated_date` is at or after the JSONL file's mtime**:

- It `stat()`s the JSONL for its `st_mtime` (returning `False`/not-fresh on `OSError`).
- Only the `"claude"` worker is currently supported: it loads the `ClaudeSession` entity by `session_id` (the JSONL file's stem). Any other worker type (`codex`/etc.) returns `False` — those sessions are never treated as fresh, so their handlers re-run every pass (this is safe because handlers are idempotent; see below). Per-worker opt-in is a deliberate `# codex/etc. — opt in per-worker as needed`.
- If the entity is missing or has no `updated_date`, it returns `False` (not fresh → process it).
- **Both timestamps are floored to microseconds** before comparison (`int(mtime * 1_000_000)` vs `int(entity.updated_date.timestamp() * 1_000_000)`). APFS carries sub-µs mtime precision that Python's `datetime` cannot represent, so comparing un-floored values would trip a false "JSONL is newer than the entity" and force a needless reparse. The floor makes the two clocks comparable.

`_process` applies the check: `if not opts.force and await _is_fresh(...): return`. So `opts.force=True` (a forced/full reindex) always bypasses freshness and replays every entry — which is why handlers must be idempotent.

### How this differs from FSIndexer `.hash` freshness

The FSIndexer's skip-fresh (`flow_sdk/fs_store/indexer/index_function.py`) is a different mechanism entirely:

- It is **entirely on-disk**: it reads each record's own `<epoch>_<hash>_<pathdigest>.hash` sentinel file (`FSRecord.index_required`) and compares the source's current hash against that sentinel. The per-record loop makes **zero DB reads** for the freshness decision itself.
- Skip-fresh additionally requires a **live DB row** (`row_present`) so a stale sentinel left behind by a DB clear/rebuild can't mask a missing row.

The transcript indexer's `_is_fresh`, by contrast, is a **timestamp comparison against the session Entity's `updated_date`** — it does not read or write any `.hash` sentinel. The two freshness systems are independent: a `CLAUDE_SESSION` record can be skip-fresh at the FSIndexer level (its `.hash` sentinel is current) while the transcript indexer still decides to reprocess it, or vice versa. In both, `opts.force` bypasses the check.

## Handler contract

Handlers implement the `TranscriptHandler` protocol (`flow_sdk/fs_store/transcript_indexer/handler.py`):

```python
class TranscriptHandler(Protocol):
    match_kind: ClassVar[EntryKind | None]
    match_tool_name: ClassVar[str | None]
    async def handle(self, entry: TranscriptEntry, ctx: TranscriptContext) -> None: ...
```

- `match_kind` / `match_tool_name` are the class-level matchers. The dispatcher feeds them straight into the analyzer's `AgentTranscriptFile.filter(kind=..., tool_name=...)` (`flow_sdk/transcript_analyzer/transcript.py`), which yields only entries matching **all** provided filters (they are AND-ed; a `None` filter matches everything). `tool_name` matches any parsed entry that carries a tool name, including semantic operation entries like `shell_command`.
- `handle` receives the matched `TranscriptEntry` and a `TranscriptContext` — a frozen dataclass carrying the `jsonl_path` and the parsed `AgentTranscriptFile`.
- Handlers are registered on an indexer instance via `TranscriptIndexer.add_handler(handler)`.

**Handlers must be idempotent.** The package docstring (`flow_sdk/fs_store/transcript_indexer/__init__.py`) states this contract: a forced reindex replays every entry, and any persisted side effect (entity creation, `private_context_entities` append) is dedup-safe by design. A handler exception is caught and logged (`logger.warning`) per entry, so one bad entry never aborts the walk.

## Shipped handlers

### PlanHandler

`PlanHandler` (`flow_sdk/fs_store/transcript_indexer/handlers/plan_handler.py`) cross-links a `ClaudePlan` to the `AgenticProcess` that produced it.

- **Matchers:** `match_kind = EntryKind.TOOL_USE`, `match_tool_name = "ExitPlanMode"`. It only acts on `ExitPlanModeEntry` instances (`flow_sdk/transcript_analyzer/entries/exit_plan_mode.py`), whose `plan_file_path` exposes the persisted plan file (from the `planFilePath` field on newer Claude Code `ExitPlanMode` tool_input; older versions omit it, so absence is "not available", not an error).
- **What it does** in `handle`:
  1. Resolves the `ClaudePlan` via `resolve_plan(entry.plan_file_path)` — see the on-demand fallback below. Returns early if the plan can't be resolved.
  2. Resolves the owning process via `AgenticProcess.get_by_session_id(entry.session_id)`. Returns early if absent.
  3. Sets the AP's `plan_path` scalar when stale (only saves if the value actually changed).
  4. Mutually links the two through the generic `cross_link_entities(plan, proc, b_data={"path": path_str})` primitive (`flow_sdk/core/entity/cross_link.py`), which writes into each side's `private_context_entities`.

**On-demand index fallback.** `resolve_plan` first tries `ClaudePlan.get_one({"asset_ref": path_str})`. If the plan file exists on disk but hasn't been indexed yet — the common case when the streamer writes the plan then immediately cross-links — it runs a scoped reindex via `_index_single_plan` and retries the lookup. It returns `None` for an empty/absent path or when even the scoped reindex yields no entity.

This same plan resolver is shared beyond the indexer: `AgenticProcess.on_plan_created` (`flow_sdk/builtin/agentic_process/agentic_process.py`) calls `resolve_plan` on the live streamer path, so a plan detected mid-session is cross-linked identically to one discovered later by the indexer.

**Codex parity.** Although `ExitPlanModeEntry`'s docstring says only the Claude parser emits it as a real tool_use, the Codex parser (`flow_sdk/transcript_analyzer/parsers/codex.py`) *synthesizes* an `ExitPlanModeEntry` from a `<proposed_plan>...</proposed_plan>` marker so `PlanHandler` (and the analyzer's `latest_plan`, the UI "Open last plan" button) treat Codex plans identically to Claude's.

`PlanHandler` is the only handler exported from the `handlers` package (`flow_sdk/fs_store/transcript_indexer/handlers/__init__.py`).

## Single-file indexers

`single_file_indexers.py` (`flow_sdk/fs_store/transcript_indexer/handlers/single_file_indexers.py`) is not a transcript handler — it houses the generic scoped-reindex helper that `PlanHandler`'s `resolve_plan` fallback uses, and that the dock loader's 404 self-heal path calls directly.

### The generic helper

`_index_single_file(root, indexer_fn, record_type, root_record_type=USER_HOME_FOLDER)` builds a throwaway `FSIndexer` rooted at a single `root`, registers just the one `indexer_fn` for the one `record_type`, and runs it with `IndexerOptions(types=[record_type], force=True, verbose=False)`. `force=True` bypasses skip-fresh so a **freshly created file is picked up on its first call** — the whole point of a self-heal path is that the record isn't in the DB yet.

### Per-type wrappers

Each wrapper computes the correct `root` from the hint path's on-disk layout (different indexer functions expect different parent depths) and delegates to `_index_single_file`:

| Wrapper | Layout it expects | Root computed | Indexer fn / record type |
|---------|-------------------|---------------|--------------------------|
| `_index_single_plan` | `~/.claude/plans/<name>.md` | `parents[2]` (`~`) | `claude_plan_fn` / `PLAN` |
| `_index_single_markdown` | `<root>/.claude/docs/**/*.md` | `parents[2]` | `markdown_flat_fn` / `MARKDOWN` |
| `_index_single_skill` | `<root>/.claude/skills/<name>/SKILL.md` (or the skill dir) | `parents[2]` of the skill dir | `skill_fn` / `SKILL` |
| `_index_single_claude_md` | `<root>/CLAUDE.md` or `<root>/.claude/CLAUDE.md` | file's parent, stepped up if `.claude/` | `claude_md_in_project_root_fn` / `CLAUDE_MD` |
| `_index_single_claude_session` | `~/.claude/projects/<encoded>/<sid>.jsonl` | the encoded project dir | `claude_sessions_fn` / `CLAUDE_SESSION` (root type `PROJECT`) |
| `_index_single_claude_memory` | `~/.claude/projects/<encoded>/memory/<name>.md` | `parents[4]` (`~`) | `claude_memory_fn` / `CLAUDE_MEMORY` |
| `_index_single_claude_rules` | `<root>/.claude/rules/<name>.md` | `parents[2]` | `claude_rules_fn` / `CLAUDE_RULES` |
| `_index_single_command` | `<root>/.claude/commands/<name>.md` | `parents[2]` | `command_fn` / `COMMAND` |

`_index_single_markdown` handles only the flat `.claude/docs/` layout (via `markdown_flat_fn`); project-scoped markdown picked up by the folder walker uses a different setup and is left to the regular project walks.

### The 404 self-heal path

The wrappers are consumed by the dock loader's self-heal in `flow_sdk/server/routes/graph.py`. When an action handler needs a `self` entity and the target 404s, `_try_self_heal_missing_entity` checks for a `?hint_path=<file>` query param; if present and the file exists, it looks up the matching wrapper by the target type and runs it, then retries the lookup after resetting the per-request entity cache. `_get_self_heal_indexers` wires the `plan`, `markdown`, `skill`, `claude_md`, `claude_memory`, `claude_rules`, and `command` types to their wrappers (built lazily so the import cost only lands on an actual self-heal).

This is deliberately gated on an explicit path hint, per the no-auto-indexing rule: it only fires when the caller supplied `hint_path` — e.g. a chip click that originated from a context entry carrying `data.path` — never as an implicit background walk.

## How and when it runs

Because `TranscriptIndexer` is an `IndexerFunc` registered on `CLAUDE_SESSION`, it runs as a **stage of a normal FSIndexer walk** once a caller opts in by wiring it up:

```python
ti = TranscriptIndexer()
ti.add_handler(PlanHandler())

idx = FSIndexer(roots=[FSRef(home, record_type=RecordType.USER_HOME_FOLDER)])
idx.add_function(RecordType.USER_HOME_FOLDER, claude_projects_fn)   # → PROJECT
idx.add_function(RecordType.PROJECT, claude_sessions_fn)            # → CLAUDE_SESSION
idx.add_function(RecordType.CLAUDE_SESSION, ti)                     # transcript pass
await idx.index(IndexerOptions(verbose=False))
```

The walk discovers projects, expands each project into its `CLAUDE_SESSION` nodes, and then — because `ti` is registered on `CLAUDE_SESSION` — feeds each session node's JSONL through the transcript indexer. `TranscriptIndexer` is an **async** walker; the FSIndexer accumulates async-walker calls inside each DFS chunk and awaits them on the main loop after the chunk returns (see the chunked-DFS note in `index_function.py`). This wiring is exercised in `tests/unit/test_fs_store/test_transcript_indexer.py` and the `scripts/analyze_this_session.py` / `scripts/bench_indexer.py` probes.

Two entry points therefore drive transcript-derived side effects:

- **The transcript indexer pass** — batch, over a walk, gated by `_is_fresh` (unless forced).
- **The live streamer** — `AgenticProcess.on_plan_created`, mid-session, sharing the same `resolve_plan` resolver so a plan is cross-linked whether it's caught live or on the next index.

## See also

- [entity-index-sync.md](./entity-index-sync.md) — how Records sync down to the Entity DB.
- [scan-and-discovery.md](./scan-and-discovery.md) — the FSIndexer walk and per-type functions.
