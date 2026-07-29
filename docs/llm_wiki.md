---
id: 5302e32d-a229-5a98-af31-939662265ef6
---

# Wiki namespaces and link graph — flowpad-oss

> **This document used to be a design plan** that described the wiki link graph as something to be built ("a graph primitives layer that does not yet exist"). That plan has shipped. The layer now exists as the `flow_sdk/wiki/` package, is wired into every record sync, and is exercised end-to-end by the editor. This document describes the system as it actually stands in code.

The wiki layer has two related but distinct parts:

- **Namespace resolution.** Every Project owns one stable default `Wiki` entity. A `WikiEntry` is an explicit binding from one canonical word to one target `TypeId`. If no entry exists, the default Wiki may resolve an exact-name project asset implicitly. This is the identity layer used by UI navigation and shared by the local server and Hub.
- **Occurrence graph.** `[[...]]` references inside markdown-backed records are parsed into queryable outgoing edges and backlinks. Every record sync replaces that record's prior rows in the `links` table.

`Wiki` and `WikiEntry` are DB-only entities; page content continues to belong to normal assets such as `markdown`, `skill`, or any other editor-backed type. The Wiki stores identity and bindings, not document bytes.

The occurrence API is deliberately **type/id-only** — it never imports `FSRecord` or `Entity`, so either layer can call it. See the package docstring at `flow_sdk/wiki/__init__.py`.

Source files:

| File | Purpose |
|---|---|
| `flow_sdk/wiki/__init__.py` | Public API: `outgoing`, `backlinks`, `index`, `delete_for_id` + the `WikiLink` type |
| `flow_sdk/wiki/indexer.py` | Orchestrates parse → resolve → store for `index()`; thin pass-throughs for reads and delete |
| `flow_sdk/wiki/parser.py` | `parse_links(body)` — extracts wiki/embed/markdown-link occurrences from a body |
| `flow_sdk/wiki/resolver.py` | `resolve_link(link, ...)` — maps a parsed `WikiLink` to a concrete `(target_type, target_id)` |
| `flow_sdk/wiki/service.py` | Default-Wiki lifecycle plus explicit/implicit word resolution |
| `flow_sdk/wiki/store.py` | `AsyncLinkStore` — async CRUD on the `links` table over the shared SQLAlchemy engine |
| `flow_sdk/wiki/types.py` | `WikiLink` frozen dataclass |
| `flow_sdk/builtin/wiki.py` | DB-only `Wiki` and `WikiEntry` entities |
| `flow_sdk/schema/type_info/wiki_*_type_info.py` | Registry metadata and icons for both entity types |
| `flow_sdk/app/actions/wiki_action.py` | Wiki resolve/bind/unbind/default-Wiki actions and occurrence graph actions |
| `flow_sdk/cloud_client/wiki_cache.py` | Desktop-to-Hub bridge and metadata-only remote cache |
| `flow_sdk/db/drivers/sqlite/connection.py` | `LinksSchema` — the `links` table ORM definition |
| `flow_sdk/server/routes/wiki.py` | Deprecated unscoped resolve compatibility endpoint |

---

## What a wiki link is

A wiki link is any of the reference forms the parser recognizes in a record's body. The parser (`flow_sdk/wiki/parser.py`) accepts:

| Form | Meaning |
|---|---|
| `[[name]]` | wikilink |
| `[[name\|alias]]` | wikilink with display text |
| `[[name#heading]]` | wikilink with a heading anchor |
| `[[name^block]]` | wikilink with a block anchor |
| `![[name]]` | embed / transclusion |
| `[text](./path.md)` | internal markdown link — relative, ends in `.md` (optionally with a `#fragment`); `http(s)://` targets are excluded |
| `[text](/dock/assets/wiki/<name>)` | legacy local wiki dock-route link |
| `[text](/dock/assets/wiki/<wiki-ref>/<name>)` | canonical local wiki dock-route link |
| `[text](/dock/hub/assets/wiki/<wiki-ref>/<name>)` | canonical Hub wiki dock-route link |

Two regexes drive wiki/embed matching and internal-markdown matching, plus a third for the dock-route form (`_WIKILINK_RE`, `_MD_LINK_RE`, `_WIKI_URL_RE` in `parser.py`). Before any of them run, `_mask_code_regions` replaces fenced code blocks (```` ``` ```` / `~~~`) and inline code spans with equal-length runs of spaces, so links inside code are never matched while line and column offsets are preserved.

The parser stores minimally: `WikiLink.raw` holds the **full inner text** — everything between `[[` and `]]` for wiki forms, or the path / decoded name for markdown forms. Alias, heading, block, and sub-path are **not** stored as separate fields; they are derived from `raw` on demand by callers that need them. This keeps the storage to a single `TEXT` column (`target_raw`) while preserving all information. `parse_links` returns `WikiLink` objects with only `raw` and `line` populated — `src_*` is filled by the indexer and `target_*` by the resolver.

The `WikiLink` dataclass (`flow_sdk/wiki/types.py`) is frozen and carries: `raw`, `line`, `src_type`, `src_id`, `target_type`, `target_id`, and `id` (the DB row id, `None` until persisted). `target_type` / `target_id` are `None` when the link is unresolved.

---

## Edge extraction on every sync

Edge extraction is not a separate pass or a background job — it runs inline as **step 4 of `FSRecord.sync_to_db`** (`flow_sdk/fs_store/fs_record.py`). The full pipeline there is:

1. Entity row via `Entity.from_record(self)`
2. Mirror DB state back to `metadata.json` via `sync_from_entity`
3. FTS upsert
4. **Wiki edge re-extraction** via `await wiki.index(self.type, self.id, self.wiki_body())`
5. Type-specific `TypeInfo.post_sync_fn`

The whole pipeline runs inside a **single shared DB session**, so the wiki write commits or rolls back together with the entity and FTS writes. The `wiki.index` call is wrapped in a try/except that logs a warning on failure rather than aborting the sync — a bad body never blocks a record from indexing.

The body handed to the wiki layer is `FSRecord.wiki_body()`, which returns the record's `body` attr, falling back to `content` (`fs_record.py`). Records with neither return `None`, and `wiki.index` treats `body is None` as a no-op (the record is simply not a wiki source). An **empty** body is different: it deletes all existing edges for that source and inserts none — i.e. clearing a document's links is honored.

Inside `wiki.index` (`flow_sdk/wiki/indexer.py`) the sequence is: `parse_links(body)` → `resolve_link(...)` for each parsed link → `AsyncLinkStore.replace_for_source(type, id, resolved)`.

---

## Namespace entities and page resolution

### Project default Wiki

`Project.save()` eagerly calls `ensure_default_wiki(project)`. The Wiki id is a deterministic UUID v5 minted from `project:<project-id>:default-wiki`, so repair is idempotent and a missing Project→Wiki child edge can be restored without inventing another namespace. On the desktop, `@local` is a Project-scoped alias handled by `Wiki.get_by_uname`; it is not persisted as the Wiki's uname and is not sent to Hub.

Every project-owned asset is available through this default Wiki without creating a row per asset. `resolve(wiki, word)` canonicalizes the word while preserving case and Unicode, then applies:

1. Look for `WikiEntry` children with the exact canonical word. Existing explicit entries take precedence; an entry whose target no longer exists resolves as `missing`, never through an implicit fallback.
2. If there is no entry and this is the Project's deterministic default Wiki, search only Project-owned file/folder assets for exact `name` or `uname`.
3. Return the identity union `{kind: "resolved", target_typeid, source: "entry"|"implicit"}`, `{kind: "missing"}`, or `{kind: "ambiguous"}`.

`bind` and `unbind` are idempotent. A `WikiEntry` id is a deterministic UUID v5 of `(wiki id, canonical word)`, and its `target_typeid` points at the asset without turning that relationship into record metadata.

Hub applies the caller's read ACL to both explicit targets and implicit Project children. An unreadable or deleted explicit target resolves as `missing` without falling through or disclosing the target; binding an unreadable target returns not-found.

### Occurrence resolution

`resolve_link` (`flow_sdk/wiki/resolver.py`) maps a parsed `WikiLink` to a concrete target entity. The current implementation resolves on the record **name** as written to disk:

1. **Derive the name candidate** from `raw` via `_record_name_from_raw`: strip the alias (`|...`), heading (`#...`), and block (`^...`) decorations, drop a trailing `.md`, discard `.`/`..` path segments, and take the **first** remaining path segment. So `[[foo/bar#sec|Alias]]` resolves on `foo`.
2. **Query candidates** by that name via `AsyncLinkStore.find_entities_by_uname_or_name`: it first matches the indexed `uname` column on the `entities` table, and only if that returns nothing falls back to a `json_extract(data, '$.name')` match. Both run on the shared SQLAlchemy engine.
3. **Pick deterministically** via `_pick_candidate`: sort candidates by `(type, id)`; if the source record's own `src_type` appears among them, prefer that type (so a same-type target wins ties); otherwise take the alphabetically-first candidate.

If no name can be derived, or no candidate matches, the returned `WikiLink` keeps `target_type` / `target_id` at `None` — it is stored as an **unresolved** edge. The resolver deliberately does not yet implement folder-as-doc fallthrough, sub-paths beyond the first segment, or heading/block/alias resolution; because `raw` is preserved verbatim in the stored column, those can be re-derived later without re-walking any files.

---

## The edge store

`AsyncLinkStore` (`flow_sdk/wiki/store.py`) is a stateless async CRUD wrapper over the `links` table, using the same async SQLAlchemy engine as everything else via `flow_sdk.db.session()`.

### Table schema

The `links` table is a native SQLite table (`LinksSchema` in `flow_sdk/db/drivers/sqlite/connection.py`) — one row per `[[...]]` occurrence in a source record's body:

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | autoincrement row id |
| `src_type` | TEXT | source record type |
| `src_id` | TEXT | source record id |
| `target_raw` | TEXT | the full inner text of the reference (see [What a wiki link is](#what-a-wiki-link-is)) |
| `target_resolved_type` | TEXT, nullable | resolved target type; `NULL` when unresolved |
| `target_resolved_id` | TEXT, nullable | resolved target id; `NULL` when unresolved |
| `line` | INTEGER | 1-indexed line of the occurrence in the source body |

Three indexes back the query shapes: `idx_links_src` on `(src_type, src_id)` for outgoing lookups, `idx_links_target` on `(target_resolved_type, target_resolved_id)` for backlinks, and a **partial** index `idx_links_unresolved_raw` on `target_raw WHERE target_resolved_id IS NULL` for cheap "who was pointing at this name?" sweeps.

### Transaction sharing with the request session

Every `AsyncLinkStore` method opens a session via `flow_sdk.db.session()`. That helper yields the **request session** when called inside an HTTP request, and a fresh auto-committing session outside one. The consequence is that wiki writes inside a request **share the request transaction** with the rest of the request's work — so, e.g., `Entity.delete()` + `wiki.delete_for_id()` either both commit or both roll back (see the docstrings on `flow_sdk/wiki/indexer.py` and `store.py`). Read methods pass `write=False` to get reader semantics (no `BEGIN IMMEDIATE`, WAL snapshot reads), so backlink lookups don't queue on the writer lock.

### Write and read methods

| Method | Behavior |
|---|---|
| `replace_for_source(src_type, src_id, links)` | Atomic `DELETE` of all rows for `(src_type, src_id)` then `INSERT` of the new rows. Idempotent — this is what `index()` calls. |
| `delete_for_id(type, id)` | Deletes every row mentioning `(type, id)` on **either** side (as `src` or as `target_resolved`). |
| `outgoing_from(src_type, src_id)` | Rows where the pair is the source, ordered by line. |
| `backlinks_of(target_type, target_id)` | Rows where the pair is the resolved target, ordered by source then line. |
| `find_unresolved(target_raw)` | Unresolved rows whose `target_raw` matches — the hook for promoting links when a new record appears. |
| `find_entities_by_uname_or_name(name)` | The resolver's candidate query (uname first, `data.name` fallback). |

---

## Reads: outgoing links and backlinks

The public read API is on `flow_sdk/wiki/__init__.py` and mirrored as methods on `FSRecord`:

- `wiki.outgoing(type, id)` / `FSRecord.get_links()` — edges going **out** of the record.
- `wiki.backlinks(type, id)` / `FSRecord.get_backlinks()` — edges pointing **at** the record.

Both return `list[WikiLink]`. `FSRecord.get_links` / `get_backlinks` are thin async wrappers that lazy-import `flow_sdk.wiki` and delegate (`fs_record.py`).

---

## Cleanup paths

Wiki edges must not outlive the records they connect. Two paths keep the table consistent:

**Record delete.** `FSRecord.unindex()` (which `destroy()` / `delete()` call) removes the Entity row, the FTS entry, **and** the wiki edges, calling `wiki.delete_for_id(self.type, str(self.id))` (`fs_record.py`). Like `wiki.index`, it is wrapped in a warning-on-failure try/except so a wiki hiccup never blocks the unindex.

**Orphan sweep.** When the indexer sweeps records whose source file has vanished, `_apply_orphan_action` in `flow_sdk/fs_store/indexer/index_function.py` issues a **best-effort** `wiki.delete_for_id(type_name, eid)` for **every** orphan id — regardless of whether a DB row currently exists — before the type-scoped driver delete. This is deliberate: wiki edges can outlive an entity row that was previously deleted without proper cleanup, so the sweep re-runs the idempotent delete to catch stale backlinks. Failures are swallowed per-id so one bad row doesn't abort the sweep.

Because `delete_for_id` clears edges on **either** side of the graph, deleting a record removes both its outgoing links and the backlinks other records had into it.

---

## HTTP / API surface

Wiki namespace operations use the ordinary graph action grammar on both the local server and Hub:

| Method | Route | Result |
|---|---|---|
| `GET` | `/api/v1/graph/wiki/@local` | Desktop Project's default Wiki entity |
| `GET` | `/api/v1/graph/project/<project-id>/default-wiki` | Ensure and return the stable default Wiki |
| `GET` | `/api/v1/graph/wiki/<wiki-ref>/resolve?word=<word>` | Typed `resolved` / `missing` / `ambiguous` identity union |
| `POST` | `/api/v1/graph/wiki/<wiki-ref>/bind` | Bind `{word, target_typeid}` and return the `WikiEntry` |
| `DELETE` | `/api/v1/graph/wiki/<wiki-ref>/unbind?word=<word>` | Remove an explicit binding idempotently |

After resolution, the UI follows the target through the type-neutral asset protocol:

1. `GET /api/v1/graph/<type>/<id>`
2. `GET /api/v1/graph/<type>/<id>/record/refs`
3. `GET /api/v1/graph/<type>/<id>/fs/download/<main-path>`

This makes file-backed Markdown and folder-backed assets such as Skills use the same viewer path. `record/refs` returns identity-bearing `FSRef` values; sender-local absolute paths are not the cross-machine contract.

The shared frontend can reach Hub in two deployments. In Hub-only mode its configured API base is Hub itself, so `Wiki.resolveHub` calls the canonical graph action directly. From desktop mode, `GET /api/v1/cloud/wiki/<wiki-ref>/resolve?word=<word>` is a local single-origin bridge: the local backend calls that same Hub graph action, materializes only safe remote entity metadata, and lets the normal reflected `record/refs` + `fs` path fetch content on demand.

`GET /api/v1/wiki/resolve` remains only as an unscoped compatibility adapter. New UI and SDK code must use the Wiki entity actions. Occurrence reads remain available as `/api/v1/graph/<type>/<id>/wiki/links` and `/wiki/backlinks`; `/wiki/reindex` re-extracts the source's occurrence rows.

---

## Frontend surface

Wiki links are a first-class routing method in the asset-doc URL grammar (`ui/src/navigation/asset-doc-types.ts`, `WIKI = 'wiki'`). Canonical browser URLs are:

- Desktop/local: `/dock/assets/wiki/@local/<word>`
- Hub authority: `/dock/hub/assets/wiki/<wiki-ref>/<word>`

The same OSS/desktop UI bundle serves both surfaces; Hub mode changes the SDK API base and supported page set, not the Wiki component.

- **Insertion.** The editor's "Add entity link" toolbar (`ui/src/components/wiki-toolbar/WikiLinkInsertDialog.tsx`) lets the user search any entity and insert either a `[[wikilink]]` or, in WYSIWYG mode, a clickable `[text](/dock/assets/wiki/<name>)` link — the exact form the parser's `_WIKI_URL_RE` recognizes.
- **Resolution / navigation.** A click calls `navigation.openDock(DockPointer.forWiki(...))`; React Router's Dock loader resolves the word through the typed SDK and writes context. The component never writes active context optimistically. Wiki links rendered inside a Hub page carry its page authority and Wiki UUID into the next DockPointer.
- **Rendering.** The resolved `TypeId` selects the registered asset editor. The Hub/plain surface reads `entity.record().mainRef`; the full local surface uses the normal asset editor. The Wiki URL stays word-based while the target identity and content load behind it.
- **Missing words.** A missing local `@local` word offers "Create as Markdown / Create as Whiteboard". Hub and non-local namespaces are read-only in this view and show a missing state without local creation controls.

Automated coverage lives in `tests/wiki/`, `tests/api/test_wiki_*`, `tests/api/test_hub_wiki_cache.py`, `ui/tests/unit/wiki-*`, `ui/tests/unit/navigation/AssetDocPointer.test.ts`, and the Hub's `flowpad/hub/tests/api/test_wiki.py`.
