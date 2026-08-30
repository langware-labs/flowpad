---
id: 5b8388fe-f701-5e08-b082-e02306680955
---

# Asset capsules

`flow_sdk/capsules/` stores named, JSON-compatible metadata in filesystem
assets without knowing about entity types, UUIDs, the indexer, or the DB.
`AssetCapsule.from_path(path)` dispatches on the path — folder, Markdown, or
source file — and every carrier exposes `read`, `write`, `write_if_absent`,
`remove`, and `names`.

`CapsuleData` has the same logical shape in both carriers:

```json
{"version": 1, "data": {"id": "<uuid>"}}
```

Folders store one file per name at `.flow/capsules/<name>.json`. Markdown stores
YAML inside line-anchored HTML-comment markers:

```markdown
<!-- flowpad:capsule identity
version: 1
data:
  id: <uuid>
flowpad:endcapsule identity -->
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
the name. `identity` is the folder-json identity carrier (markdown identity lives in
frontmatter now — see below); `tag` binds a source file to the subjects it
implements (see `docs/tags.md`).

`tag` is the one **repeatable** name (`_REPEATABLE_NAMES` in `line_comment.py`),
because it annotates a *position* rather than the file: a test module carries one
block per breadcrumbed test, each directly above it. The relaxation is per-name
and never global — duplicate `identity` still fails closed, which is what
`FolderJsonCarrier` relies on. Repeatable names get a positional API on the
line-comment carrier; `read`/`write`/`write_if_absent` keep acting on the first
block, so single-capsule callers are unchanged:

* `read_all(name)` → every block as `AnchoredCapsule(line, end_line, data)`
* `write_at(name, data, line=N)` → place a block immediately above 1-indexed `N`,
  replacing in place the block of `name` already anchored there rather than
  stacking a second one. Refuses an anchor that is out of range or that falls
  inside an existing block (splitting one would corrupt every later read).
* `remove(name)` drops every block of that name.

## Identity integration

Identity is not a capsule concern any more for markdown: **a markdown main
document carries its id as its first frontmatter key `id:`**. The type declares
WHERE its id lives through `TypeInfo.identity_carrier`
(`flow_sdk/fs_store/identity_carrier.py`):

| carrier | types | stores |
|---|---|---|
| `FrontmatterCarrier` / `FolderMdCarrier` | every type whose main document is markdown — markdown, claude_md, claude_memory, claude_rules, subagent, command, plan, prompt, agent, spec, and skill/task/whiteboard (`SKILL.md`, `task.md`, `WHITE_BOARD.md`) | `id:` first in the YAML frontmatter of that document |
| `FolderJsonCarrier` | folder types whose main is JSON — dataset, deck, deck_template, graph_workflow, journey | `<folder>/.flow/capsules/identity.json` |
| `NativeJsonCarrier` | reports | the `"id"` key of the report's own JSON root |
| `DerivedCarrier` | sessions, project, mcp_server, plugin, … | nothing — the id is a pure function of the source |

The seam is `TypeInfo.mint_entity_id(ref, *, proposed_id=None, owner_id=None, live_ids=None)`
— read the carrier; a live id is the answer; else the owning row; else mint and
write — and `TypeInfo.read_id(ref)`, the pure read the collision ranking and
create guards use. The carrier only reads and writes; TypeInfo owns v4/v5
validation, stable-key choice and `mint_uuid`.

```text
  1. the carrier   IF no row owns this path
                   OR the carrier IS that row
                   OR the carrier is a live id of this type
  2. else owner_id — the row that already owns ref's path (stamped back if absent)
  3. else mint     — proposed id / stable key / fresh v4, written through write_if_absent
```

The ordering axis is carrier **liveness**, not "file vs database". `live_ids` is
the oracle: `None` means "cannot prove dead", so a valid carrier always wins —
only the index walk, which holds the complete per-type id set, may conclude that
a carrier names no entity. A read-then-mint pair (`read_id(ref) or
mint_entity_id(ref)`) skips step 2 and forks the entity after a rewrite wiped
the carrier; an AST lint fails the build on that shape.

Writes happen only when the carrier is writable, the ref is not `read_only`,
and carrier writes are not suppressed — the seam checks all three, for every
caller. A present-but-invalid carrier (a hand-written v7) keeps its bytes and
resolves to a stable path-derived v5; a corrupt carrier raises.

**Legacy markdown capsules.** The HTML-comment `identity` block markdown used
to carry is still read (and stripped from bodies), and is **converted in place
on the next index**: the id moves into the frontmatter, the block is removed,
the id is unchanged. A folder's `.flow/capsules/identity.json` under a markdown
main document is copied into that document's header the same way (the json is
left). `asset_id:` and `.flow/id` stay read-only fallbacks. A file that may not
be written (read-only root, suppressed carrier writes) keeps its capsule and is
read from it indefinitely.

A source may declare that its bytes are not ours to write at all. A driver
with `stamps_identity = False` — git, whose files are tracked — runs its
reflection inside `carrier_writes_suppressed()` (`fs_store/fs_record.py`), and
the seam then answers from the carrier or a stable path-derived id without
writing. Identity for such a source converges through an `Entity.origin_id`
lookup instead. The flag is a ContextVar because the write happens four layers
below the decision. Suppression is the reason a git working tree is clean after
an index pass.

Types whose native format owns its root JSON identity use that carrier. The indexer passes the resolved id to
`from_disk_fn(ref, resolved_id)`. If the same valid capsule identity occurs at
multiple live paths, the collision resolver selects one primary by earliest Git
introduction, trusted filesystem birth time, persisted `first_seen_at`, then
canonical path. The other paths are warned and skipped without rewriting their
capsules, bytes, or ids. Collision selection is therefore an indexing concern;
the capsule package remains a carrier and never repairs copies or rekeys assets.
