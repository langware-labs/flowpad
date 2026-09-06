---
id: 5b8388fe-f701-5e08-b082-e02306680955
---

# Asset capsules

`flow_sdk/capsules/` stores named, JSON-compatible metadata in filesystem
assets without knowing about entity types, UUIDs, the indexer, or the DB.
`AssetCapsule.from_path(path)` dispatches on the path — folder (`FolderCapsule`),
Markdown (`CodeCommentCapsule`), or source file (`LineCommentCapsule`) — and
every carrier exposes `read`, `write`, `write_if_absent`, `remove`, and `names`.

`CapsuleData` has the same logical shape in every carrier:

```json
{"version": 1, "data": {"tags": {"flow.runs": "Run budgets are enforced here"}}}
```

Folders store one file per name at `.flow/capsules/<name>.json`. Markdown stores
YAML inside line-anchored HTML-comment markers:

```markdown
<!-- flowpad:capsule tag
version: 1
data:
  tags:
    flow.runs: "Run budgets are enforced here"
flowpad:endcapsule tag -->
```

Source files use the same grammar with each line behind the language's comment
leader (`COMMENT_LEADERS` maps the suffix: `#` for `.py`, `//` for
`.ts/.tsx/.js/.jsx`). The leader plus one space is stripped before parsing, so a
bare leader line is an empty YAML line:

```python
# flowpad:capsule tag
# version: 1
# data:
#   tags:
#     flow.runs: "Run budgets are enforced here"
# flowpad:endcapsule tag
```

Only absence returns `None`. Invalid names, malformed data, duplicate blocks,
unsupported versions, and unsupported file formats raise typed capsule errors.
Mutations are lock-protected and atomically replaced; same-value writes preserve
bytes and mtime. Markdown snapshot/restore helpers let an owned domain renderer
replace content without deleting or interpreting capsule blocks. Parsers and
FTS remove capsule blocks before treating the remaining text as document body.

A capsule name is a flat slug (`[a-z][a-z0-9_-]{0,63}`) and one file carries at
most one block per name — dotted vocabularies therefore live in the payload, not
the name. `tag` binds a source file to the subjects it implements (see
`docs/tags.md`). The `Sidecar` identity carrier (below) stores a folder's id as
the `identity` folder capsule, `.flow/capsules/identity.json`; that is the only
identity use of the package.

`tag` is the one **repeatable** name (`_REPEATABLE_NAMES` in `line_comment.py`),
because it annotates a *position* rather than the file: a test module carries one
block per breadcrumbed test, each directly above it. The relaxation is per-name
and never global — a duplicate of any other name still fails closed, which is what
`Sidecar` relies on. Repeatable names get a positional API on the
line-comment carrier; `read`/`write`/`write_if_absent` keep acting on the first
block, so single-capsule callers are unchanged:

* `read_all(name)` → every block as `AnchoredCapsule(line, end_line, data)`
* `write_at(name, data, line=N)` → place a block immediately above 1-indexed `N`,
  replacing in place the block of `name` already anchored there rather than
  stacking a second one. Refuses an anchor that is out of range or that falls
  inside an existing block (splitting one would corrupt every later read).
* `remove(name)` drops every block of that name.

## Identity carriers

A filesystem asset's id lives in exactly ONE place per type. The type declares
WHERE through `TypeInfo.identity_carrier` (`flow_sdk/fs_store/identity_carrier.py`):

| carrier | types | stores |
|---|---|---|
| `Frontmatter` | every type whose main document is markdown — markdown, claude_md, claude_memory, claude_rules, subagent, command, plan, prompt, agent, spec, and skill/task/whiteboard (`SKILL.md`, `task.md`, `WHITE_BOARD.md`) | `id:` first in the YAML frontmatter of that document |
| `Sidecar` | folder types whose main is JSON — dataset, deck, deck_template, graph_workflow, journey, mcp | `<folder>/.flow/capsules/identity.json` |
| `JsonRoot` | reports (`_report.py`: usage_report, asset_cleanup_report, …) | the `"id"` key of the report's own JSON root |
| `Derived` | claude/codex/copilot sessions, project, mcp_server, plugin, claude_hook, dynamic_workflow, workflow_run, markdown_index, spreadsheet, micro_app, todo_file, helpdesk, secret_origin, data_source_spec | nothing — the id is a pure function of the source (`writable = False`) |

A carrier does four things — `locate(layout)` (the path that holds the id),
`accepts(where)`, `read(where)` → `Found` / `Foreign` / `Absent`, and
`stamp(where, id)` — and nothing else: TypeInfo owns v4/v5 validation, the
stable-key choice and `mint_uuid`.

The seams on `TypeInfo` (`flow_sdk/fs_store/schema_registry.py`):

* `read_id(ref)` — the pure read; the collision ranking and every request
  handler that must never write use it.
* `mint(layout, *, write, ref=None, found=None)` — `Found` is the answer,
  `Foreign` raises `ForeignId`, absent ⇒ mint (v5 when the type has a stable
  key, else v4) and, with `write`, stamp it through the carrier.
* `stamp_id(ref, entity_id)` — the create-flow seam: a `Found` id wins,
  otherwise `entity_id` is stamped.

The index walk settles an id through `reconcile(info, layout, owner_row,
live_ids, *, write)` (`flow_sdk/fs_store/indexer/reconcile.py`); one path from
a request goes through `resolve_asset` (`flow_sdk/fs_store/resolve.py`), which
runs the same `reconcile` with the owner looked up through
`Entity.get_by_asset_ref`:

```text
  1. the carrier   IF no row owns this path
                   OR the carrier IS that row
                   OR the carrier is a live id of this type
  2. else owner_row — the row that already owns the path (stamped back if absent)
  3. else mint      — stable key / fresh v4, stamped through the carrier
```

The ordering axis is carrier **liveness**, not "file vs database". `live_ids` is
the oracle: `None` means "cannot prove dead", so a valid carrier always wins —
only the index walk, which holds the complete per-type id set, may conclude that
a carrier names no entity. A read-then-mint pair (`read_id(ref) or mint(...)`)
skips step 2 and forks the entity after a rewrite wiped the carrier; an AST lint
fails the build on that shape.

`write` gates every byte touched, and the caller decides it: the walk passes
`write=False` for a read-only root and for a source whose driver declares
`stamps_identity = False` (git, whose files are tracked — the reason a git
working tree is clean after an index pass); identity for such a source
converges through an `Entity.origin_id` lookup instead. A carrier id that is not
a valid v4/v5 reads as `Foreign`: it is logged as a `foreign_id` scan issue and
the asset indexes under a stable path-derived v5 without its bytes being
touched; a carrier that cannot be parsed raises `MalformedCarrier`. A file
still carrying a retired form (the markdown HTML-comment `identity` block, an
`asset_id:` key, a `.flow/id` line) reads as `Foreign` too — the hand-run
`flow_sdk/migrations/migration_2026_09_identity_live_forms.py` moves such ids
into the live carrier, id unchanged.

Types whose native format owns its root JSON identity use `JsonRoot`. The indexer passes the resolved id to
`from_disk_fn(ref, resolved_id)`. If the same valid carrier identity occurs at
multiple live paths, the collision resolver selects one primary by earliest Git
introduction, trusted filesystem birth time, persisted `first_seen_at`, then
canonical path. The other paths are warned and skipped without rewriting their
carriers, bytes, or ids. Collision selection is therefore an indexing concern;
the carrier only reads and stamps and never repairs copies or rekeys assets.
