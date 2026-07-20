---
id: 5b8388fe-f701-5e08-b082-e02306680955
---

# Asset capsules

`flow_sdk/capsules/` stores named, JSON-compatible metadata in filesystem
assets without knowing about entity types, UUIDs, the indexer, or the DB.
`AssetCapsule.from_path(path)` returns the folder or Markdown implementation;
both expose `read`, `write`, `write_if_absent`, `remove`, and `names`.

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

Only absence returns `None`. Invalid names, malformed data, duplicate blocks,
unsupported versions, and unsupported file formats raise typed capsule errors.
Mutations are lock-protected and atomically replaced; same-value writes preserve
bytes and mtime. Markdown snapshot/restore helpers let an owned domain renderer
replace content without deleting or interpreting capsule blocks. Parsers and
FTS remove capsule blocks before treating the remaining text as document body.

## Identity integration

Types declare `CapsuleSpec("identity", 1)` and an identity backend in
`TypeInfo`. The capsule package only transports `{"id": ...}`; TypeInfo owns
v4/v5 validation, stable-key choice, and `mint_uuid` calls:

```text
extract_id(ref)
  → canonical identity capsule
  → ordered read-only legacy/native readers
  → adopt only UUID v4/v5

mint_id(ref, proposed_id=None)
  → observe again
  → existing filesystem id wins
  → mint/propose only on absence
  → atomic store_if_absent
```

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
