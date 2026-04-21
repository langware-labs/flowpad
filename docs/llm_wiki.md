# Wiki Link Graph Primitives — flowpad-oss

## Context

Today flowpad-oss has markdown records with a naive wikilink extractor (`r'\[\[([^\]]+)\]\]'`) that produces raw strings joined into FTS `content`. There is **no link resolver, no edge table, no backlinks, no cross-type link resolution, no file watcher on doc dirs**. Every gap analysis downstream (Obsidian graph view, Karpathy ingest/lint/query, typed edges, frontend navigation) depends on a graph primitives layer that does not yet exist.

This plan builds that primitives layer — and nothing else. Scope is deliberately narrow: after this lands, `[[foo]]` resolves to a concrete record across all markdown-backed types, backlinks are queryable, edges survive file moves, and the index stays fresh on out-of-band edits. LLM ops (ingest/lint/query), graph UI, and typed edges are explicit non-goals for this phase.

**Decisions locked in with user:**
- Scope: blocking primitives only.
- Rename strategy: path-based + aliases (no UUID permalinks).

## Non-goals (explicit)

- Karpathy ingest/lint/query ops, `index.md` / `log.md` conventions.
- Frontend wikilink rendering, backlinks panel, graph view — APIs only.
- Typed edges (`uses`, `depends_on`, `contradicts`), confidence/provenance fields.
- Inline `#hashtag` extraction from body.
- Projecting DB-only records (tasks, sessions, projects) as graph nodes.
- FTS column restructuring (see Migration note).

## Files to modify / create

### New files
- `flow_sdk/fs_records/wikilink_parser.py` — standalone extractor, unit-testable.
- `flow_sdk/fs_records/link_resolver.py` — cross-type resolver, registry-injected.
- `flow_sdk/server/routes/links.py` — `/api/v1/links/*` endpoints.
- `flow_sdk/db/migrations/<next>_links_table.py` (or equivalent path for this repo's migration convention — verify at impl time).
- `tests/fs_records/test_wikilink_parser.py`, `tests/fs_records/test_link_resolver.py`, `tests/server/test_links_routes.py`.

### Modified files
- `flow_sdk/fs_records/markdown_record.py` — replace `_extract_wiki_links` (line 103-105), call parser module, emit structured `ParsedLink` list alongside existing string list (keep string list for FTS back-compat this phase).
- `flow_sdk/fs_records/asset_record.py` — same, drop local regex (line 32-34), call parser module.
- `flow_sdk/fs_records/_frontmatter.py` — no code change (dict-based parser accepts `aliases` naturally); document the field in a module docstring.
- `flow_sdk/fs_store/record.py` — in `sync_to_db` (line 1993), after existing FTS upsert, enqueue a `re-extract-edges` job for this record's `source_path`.
- `flow_sdk/fs_store/schema_registry.py` — add `canonical_filename: str | None` to `TypeInfo` (or equivalent struct — verify at impl time), populate for skill/agent/workflow types.
- `flow_sdk/db/drivers/sqlite/sqlite_driver.py` — add `links` table CREATE near the `entities_fts` block (line 348).
- `flow_sdk/server/routes/watch.py` — extend watcher (pattern at line 37) to cover doc dirs returned by `_doc_search_dirs()` in `markdown_record.py:56`.
- `flow_sdk/server/app.py` (or wherever routers are registered) — mount `links.router`.

## Design

### 1. `wikilink_parser.py` (standalone module)

```python
@dataclass(frozen=True)
class ParsedLink:
    raw: str                        # exactly what was in the source
    target: str                     # filename/name portion
    alias: str | None               # from [[target|alias]]
    heading: str | None             # from [[target#heading]]
    block: str | None               # from [[target^block]]
    scope_type: str | None          # from [[skill:target]] — explicit type override
    kind: Literal["wikilink", "embed", "markdown_link"]
    line: int
    col: int

def parse(body: str) -> list[ParsedLink]: ...
```

**Rules:**
- Skip fenced code blocks (``` / ~~~) and inline code (`` ` ``) before regex passes.
- Wikilinks: `[[...]]` — parse `|`, `#`, `^`, and leading `type:` scope marker.
- Embeds: `![[...]]` — same grammar, `kind="embed"`.
- Markdown links: `[text](path)` — only count as internal if the target matches `^(\./|\.\./)?[^:]+\.md(#.*)?$` (relative, ends in `.md`); emit with `kind="markdown_link"`.
- Track `line`, `col` for every match so the frontend can one day highlight.

**Callers:** `MarkdownRecord.from_markdown` (replaces current inline regex), `AssetRecord.from_markdown`, future lint CLI, future frontend preview via the resolve endpoint. Base-class helpers stay as thin wrappers calling `wikilink_parser.parse(body)`.

### 2. `links` table (native SQLite, not FTS)

```sql
CREATE TABLE IF NOT EXISTS links (
    id                      INTEGER PRIMARY KEY,
    src_type                TEXT NOT NULL,
    src_id                  TEXT NOT NULL,
    src_path                TEXT NOT NULL,         -- denormalized cache
    target_raw              TEXT NOT NULL,
    target_resolved_type    TEXT,                  -- NULL if unresolved
    target_resolved_id      TEXT,                  -- NULL if unresolved; authoritative on reads
    target_resolved_path    TEXT,                  -- denormalized cache
    kind                    TEXT NOT NULL,         -- wikilink | embed | markdown_link
    heading                 TEXT,
    block                   TEXT,
    line                    INTEGER NOT NULL,
    col                     INTEGER NOT NULL,
    ambiguous               INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_links_src_id              ON links(src_type, src_id);
CREATE INDEX idx_links_target_resolved_id  ON links(target_resolved_type, target_resolved_id);
CREATE INDEX idx_links_target_raw          ON links(target_raw)
    WHERE target_resolved_id IS NULL;             -- partial, for unresolved sweeps
CREATE INDEX idx_links_target_path         ON links(target_resolved_path);
```

**Rationale** (from design review): FTS5 is wrong shape for graph joins — no secondary indexes on columns, no equality lookup. Backlinks = `WHERE target_resolved_id = ?`; 1-hop neighbors = join on `src_id` / `target_resolved_id`. Partial index on unresolved rows keeps "new record — who was pointing here?" cheap.

**Key insight from review (item 9):** `target_resolved_id` is authoritative; paths are denormalized cache. On rename, one `UPDATE links SET src_path=? WHERE src_id=?` + `UPDATE links SET target_resolved_path=? WHERE target_resolved_id=?` keeps the graph correct without re-extraction.

### 3. `link_resolver.py`

```python
def resolve(
    raw: str,
    *,
    scope_type: str | None,          # from [[type:name]] override
    src_path: Path,
    src_type: str,
    schema_registry=SchemaRegistry,
) -> ResolvedLink | None: ...
```

**Resolution order:**
1. If `scope_type` present → restrict to that type only.
2. Exact alias match in any markdown-backed record's `aliases[]`.
3. Path fallthrough for target `foo`:
   - `foo.md` (flat, same dir as src first, then all doc dirs)
   - `foo/foo.md` (folder-same-name)
   - `foo/<canonical>.md` — canonical file per type from `TypeInfo.canonical_filename` (`SKILL.md`, etc.)
   - `foo/index.md`
   - `foo/README.md`
4. Title match (case-insensitive) across all markdown-backed records.
5. Shortest-path disambiguation when multiple candidates: precedence = same-folder-and-type > same-type-any-folder > docs > skills > agents > rest, alphabetical within tier. Set `ambiguous=True` when >1 candidate tied at the chosen tier.

**Circular imports:** never import concrete record classes at module top. Use `SchemaRegistry.get_all_types()` filtered by `"is_markdown_backed"` attribute on `TypeInfo`; lazy-import `MarkdownRecord` inside the function if needed. Query the existing `entities` table for name/alias/title matches rather than loading records.

### 4. Aliases frontmatter

New standard frontmatter field:
```yaml
aliases: [old-name, other-alias]
```

`_frontmatter.py` already returns `dict[str, Any]` — no parser change needed. Add reading/normalization in `MarkdownRecord.from_markdown` (and the equivalent asset path); store on the entity row as a new column `aliases TEXT` (JSON-encoded list). On rename, the UI layer (future) will append the old filename stem to `aliases[]` — this phase only adds the field, the reading, and the alias path in the resolver. No migration: existing records default to `[]`.

### 5. Edge upsert — single-writer queue

**New component:** `flow_sdk/fs_store/link_indexer.py`

```python
_queue: asyncio.Queue[tuple[str, Path]]   # (src_type, src_path)

async def run_worker():
    while True:
        src_type, src_path = await _queue.get()
        await _reextract_and_upsert(src_type, src_path)

async def enqueue(src_type: str, src_path: Path): ...

async def _reextract_and_upsert(src_type, src_path):
    # 1. parse body → list[ParsedLink]
    # 2. resolve each → ResolvedLink | None
    # 3. single txn: DELETE FROM links WHERE src_path=?;  INSERT rows
    # 4. for any newly-created record: UPDATE unresolved edges with matching target_raw
```

**Both paths feed the queue:**
- `sync_to_db` (`fs_store/record.py:1993`) — after FTS upsert, `await link_indexer.enqueue(...)`.
- Watcher (`server/routes/watch.py`) — on file change event, `enqueue`.

**Rationale:** SQLite serializes writes anyway; the queue makes interleaving explicit, collapses rapid save+filewatch duplicates via `(src_path, timestamp)` dedup on enqueue, and gives backpressure. Per-path 500ms debounce in the enqueue layer.

### 6. File watcher extension

`flow_sdk/server/routes/watch.py` currently watches `.claude/projects/<dir>` for transcripts (line 37, `.jsonl` filter). Extend with a **second** watcher task that:
- Watches every path from `markdown_record._doc_search_dirs()` (line 56).
- Filters `.md` only.
- On create/modify/delete → `link_indexer.enqueue(...)` (single queue, single writer, as above).
- Uses `debounce=200` on `awatch` like the existing usage.
- Single task over all dirs (not per-dir) — matches review recommendation.

### 7. API routes — `flow_sdk/server/routes/links.py`

```
GET  /api/v1/links/backlinks?target_path=...&target_id=...
     → [{src_type, src_id, src_path, line, col, kind}]

GET  /api/v1/links/neighbors?path=...&depth=1
     → {nodes: [...], edges: [...]} — BFS via recursive CTE

GET  /api/v1/links/resolve?raw=foo&from_path=...&scope_type=...
     → ResolvedLink | {candidates: [...], ambiguous: true}

GET  /api/v1/links/broken
     → links with target_resolved_id IS NULL (paginated)

POST /api/v1/links/reindex
POST /api/v1/links/reindex/{record_type}
     → re-walk all files of that type, rebuild their edges
```

Follow the router conventions already in `flow_sdk/server/routes/search.py:16` (plain `APIRouter()`, explicit paths in decorators).

### 8. Unresolved → resolved transitions

After `INSERT` of a new record's edges, do one targeted sweep:

```sql
SELECT id FROM links
WHERE target_resolved_id IS NULL
  AND target_raw IN (:stem, :title, :alias1, :alias2, :folder_name);
```

For each hit, re-run resolver; if now resolves → `UPDATE`. Cheap per-create. Full unresolved sweep only on startup and explicit `/reindex`.

## Things to reuse (do not rebuild)

- `MarkdownRecord._external_source_iter` / `discover` (`record.py:1180-1208`) — already enumerates markdown-backed records.
- `_doc_search_dirs()` (`markdown_record.py:56`) — source of truth for directories to watch.
- `SchemaRegistry.get_all_types()` (`schema_registry.py:375`) — registry enumeration.
- `watchfiles.awatch` pattern (`server/routes/watch.py:37`) — mirror with different path list + filter.
- `Entity.search()` FTS layer — untouched this phase.
- Existing `sync_to_db` hook — add enqueue at end, no refactor.
- `_frontmatter.py` — no change; frontmatter dict already open-ended.

## Migration & back-compat

- **FTS content column unchanged:** current `search_content` in `markdown_record.py:230-244` keeps appending `" ".join(links)`. Users searching by link text keep their current results. Separating links out of FTS content is a follow-up PR, deliberately.
- **New `links` table** is additive; no change to `entities_fts` schema.
- **New `aliases` column** on `entities` table defaults to `[]`; existing rows unaffected until next `sync_to_db`.
- **First-run reindex** required to populate `links` table: server boot checks `SELECT COUNT(*) FROM links`; if zero, runs full reindex in background (log a warning).

## Verification

Unit:
- `tests/fs_records/test_wikilink_parser.py` — table-driven: all six link forms, code-fence skips, embedded pipe/hash/block combos, scoped `type:name`, markdown links to `.md`, false positives inside ``` blocks.
- `tests/fs_records/test_link_resolver.py` — fixture vault with: two records same filename different types, alias match, folder-as-doc, per-type canonical file (SKILL.md, agent `.md`), ambiguous case, scoped override.
- `tests/fs_store/test_link_indexer.py` — enqueue dedup, single-writer serialization, unresolved sweep on new record.

Integration:
- `tests/server/test_links_routes.py` — seed fixture vault, hit `/backlinks`, `/neighbors`, `/resolve`, `/broken`.
- Manual: start backend (`uv run -m flow_sdk.server.run`), create two docs under `docs/` linking to each other, confirm `/api/v1/links/backlinks` returns the inbound edge within ~1s of file save (watcher debounce + worker).
- Rename manual: rename `docs/foo.md` → `docs/bar.md` on disk. Watcher fires; `/backlinks` should still resolve inbound links as long as caller added `foo` to `bar.md`'s `aliases:`. Without alias, broken link should appear in `/api/v1/links/broken`.

Regression:
- Existing `GET /api/v1/search` should return same results for a corpus before and after the migration (links still in FTS `content` this phase).
- Existing `/api/v1/search/reindex` unaffected.

## Risks / open items

- **Watcher churn during LLM ingest** — if a future ingest flow writes 15 docs in a burst, queue depth matters. Debounce + dedup should handle it; measure on first real ingest.
- **Doc-dir set is dynamic** — `_doc_search_dirs()` re-reads env + filesystem each call. The watcher caches at start; changes to `FLOWPAD_DOC_DIRS` mid-session are not picked up. Acceptable for this phase; add a `/links/rescan-roots` endpoint if it bites.
- **`src_id` for hybrid records** — skill/agent/workflow store both YAML and markdown. Confirm at impl time that `source_path` + `id` resolve to the single canonical row (cite: `agent_record.py:107-115`, `skill_record.py:47-60`). If not, the edge table key story needs adjustment.
- **Concurrent writes to `entities` and `links`** — both happen inside `sync_to_db`; ensure they're in the same transaction or the link worker will occasionally see a stale entity row. Single-queue worker naturally resolves this.
