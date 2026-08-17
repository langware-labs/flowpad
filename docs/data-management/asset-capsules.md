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
the name. `identity` is the canonical kind; `tag` binds a source file to the
subjects it implements (see `docs/tags.md`).

`tag` is the one **repeatable** name (`_REPEATABLE_NAMES` in `line_comment.py`),
because it annotates a *position* rather than the file: a test module carries one
block per breadcrumbed test, each directly above it. The relaxation is per-name
and never global — duplicate `identity` still fails closed, which is what
`CapsuleIdentityBackend` relies on. Repeatable names get a positional API on the
line-comment carrier; `read`/`write`/`write_if_absent` keep acting on the first
block, so single-capsule callers are unchanged:

* `read_all(name)` → every block as `AnchoredCapsule(line, end_line, data)`
* `write_at(name, data, line=N)` → place a block immediately above 1-indexed `N`,
  replacing in place the block of `name` already anchored there rather than
  stacking a second one. Refuses an anchor that is out of range or that falls
  inside an existing block (splitting one would corrupt every later read).
* `remove(name)` drops every block of that name.

## Identity integration

Types declare `CapsuleSpec("identity", 1)` and an identity backend in
`TypeInfo`. The capsule package only transports `{"id": ...}`; TypeInfo owns
v4/v5 validation, stable-key choice, and `mint_uuid` calls:

```text
mint_entity_id(ref, *, owner_id=None, live_ids=None,
               proposed_id=None, derive=False, overwrite=False)

  observe the carrier ONCE
    → canonical identity capsule
    → ordered read-only legacy/native readers
    → adopt only UUID v4/v5   (a foreign id reads as "no carrier")

  1. the carrier   IF no row owns this path
                   OR the carrier IS that row
                   OR the carrier is a live id of this type
  2. else owner_id — the row that already owns ref's path
  3. else derive   — stable key / path-v5 / fresh v4   [derive=True]
                     committed via atomic store_if_absent [overwrite=True]
```

The ordering axis is carrier **liveness**, not "file vs database". `live_ids` is
the oracle: `None` means "cannot prove dead", so a valid carrier always wins —
only the index walk, which holds the complete per-type id set, may conclude that
a carrier names no entity.

There is no separate extract/mint pair. A read-then-mint pair (`extract_id(ref)
or mint_id(ref)`) skips step 2, so a full-content rewrite that wiped the carrier
invents a new id for a path a row already owns — forking the entity and leaving
every bookmark and display pin dangling. An AST lint fails the build on that
shape and on the old method names.

`derive=False` (the default) is the read-only probe: it answers only from
evidence and returns `None` when there is none. Collision-identity ranking,
create guards and publication assertions all depend on that `None` — a derived
value would make two unstamped copies look identical. An INVALID carrier keeps
its bytes even under `overwrite`; only an ABSENT one is stamped.

Legacy Markdown `id`/`asset_id`, folder `.flow/id`, and manifest identities
remain readable without cleanup, backfill, or dual-write. Types whose native
format owns its root JSON identity continue using that carrier intentionally.
An invalid canonical id is preserved; a valid compatibility identity can still
be adopted, otherwise resolution uses a stable v5. Corrupt, duplicate, or
future-version capsule data fails closed. The indexer passes the resolved id to
`from_disk_fn(ref, resolved_id)`. If the same valid capsule identity occurs at
multiple live paths, the collision resolver selects one primary by earliest Git
introduction, trusted filesystem birth time, persisted `first_seen_at`, then
canonical path. The other paths are warned and skipped without rewriting their
capsules, bytes, or ids. Collision selection is therefore an indexing concern;
the capsule package remains a carrier and never repairs copies or rekeys assets.
