---
id: 6a0e52a8-3fdb-595b-a53d-d05a4bddb1cc
---

# Items & origins

An **origin** answers *where does the real thing live*. It is a value object,
never an entity: a `kind` discriminant plus locator fields, no behaviour and no
secrets. Behaviour lives in a `kind`-keyed driver registry.

Three sibling families answer three different versions of that question. They
are deliberately parallel in shape and deliberately **not** one type — their
resolution contracts have nothing in common.

| Family | Answers | Kinds today | Resolves to |
|---|---|---|---|
| `FSOrigin` | where an asset's **bytes** live | `git`, `local` | a directory on disk |
| `CloudOrigin` | where a record's **truth** lives | free string — `gmail`, `slack`, `jira`, `gcp` | a mutable remote record |
| `SecretOrigin` | where a **value** resolves | `local`, `env-local`, `flowpad-hub`, `gcp`, `1password` | a string, at worker launch, never persisted |

This document covers `FSOrigin` — the data-layer carrier. Bundle *transport*
(how origins ride a share) is [messages and attachments](../collab/messages-and-attachments.md).

> **Supersedes** the `GitOrigin` glossary entry in
> [`collab/index.md`](../collab/index.md). That entry describes `GitOrigin` as
> "the single git pointer", which predates the `kind`-tagged `FSOrigin` union.

## Shape

```
FSOrigin                         kind · rel_path   (project_id / id: local slots, excluded from every dump)
  ├── GitOrigin   kind="git"     provider · owner · name · branch · head_commit
  └── LocalOrigin kind="local"   base

OriginField = Annotated[Union[GitOrigin|"git", LocalOrigin|"local", CloudOrigin|"cloud"], Discriminator(origin_tag)]
SoftOrigin  = Annotated[Optional[OriginField], WrapValidator(soft)]   # malformed → None, the ONE tolerance rule
```

`rel_path` is the universal placement contract — the asset **root** relative to
the origin's root (a folder for folder-layout types, a file for file-layout
types). `.` means the whole repository.

**The discriminator is tolerant by design.** A dict with no `kind` reads as
`git`, because origins persisted before the discriminant existed were all git.
That rule lives in exactly one place, `resolve_origin_kind`, the union's
discriminator (`origin_tag`, `fs_store/origin/field.py`): missing kind → git, a
git-hosting name folds onto git, `local` is local, anything else is a `CloudOrigin`
(whose `kind` is the open CHANNEL string). `ORIGIN_ADAPTER` validates a raw value
the same way the entity field does — typed, or `None` when malformed.

Store an origin in a field typed `OriginField`, never bare `FSOrigin` — a
bare-base field instantiates the base and silently drops the subclass locator.

## The driver registry

`FSOriginDriver` (`fs_origin_driver.py`) holds behaviour per kind:

| Method | Contract |
|---|---|
| `materialize(origin, …)` | fetch/reuse bytes; returns `(local_root, project_id)` — **the origin ROOT**, callers join `rel_path` themselves |
| `matches(origin, path)` | is this local dir that origin? |
| `detect(path)` | reverse: what origin is this path? |
| `key(origin)` | deterministic cross-machine dedup handle |

The registry is kind-agnostic and folds git-hosting aliases (`github`, `gitlab`,
`bitbucket`) onto `git`. Drivers are lazy-imported so a backend's dependencies
load only when that kind is used.

Two current limits worth knowing before building on it: `materialize` returns a
directory and one consumer checks `is_dir()`, so there is no single-file path;
and it takes **no credential argument** — the git driver clones without a token,
so the `FSOrigin` path is effectively public-repo-only today. The registry
docstring's claim that drivers resolve credentials from the receiver's store is
aspirational.

## `key()` is a dedup handle, not an id

```
GitOrigin.key()   = uuid5(NAMESPACE_URL, "<canonical-remote-key>:<rel_path>")
LocalOrigin.key() = canonical path  (== Folder.id_for_path)
```

Branch-independent and case-folded on owner/name, so the same asset position in
the same repo yields the same key on every machine — that is what lets
"received now" and "cloned later" reconcile by value.

`key()` is used as an **entity id in exactly one place**: `Folder.id_for_origin`,
where the folder id *is* the origin's key. Everywhere else it is dedup,
reconciliation comparison, or a scratch directory name — including
`Entity.origin_id`, where a git data source persists it so re-observations of
the same repo position resolve to one row by lookup rather than by re-deriving
an id.

**It must not change.** It is pinned to a literal in
`tests/unit/test_fs_origin.py` and is a live Folder id reconciled across
machines; altering it silently breaks dedup for everything already shared.

## Where an origin lives — four jobs, not one inconsistency

Several entities carry origin-shaped fields with different types. This looks
like drift and is not; each answers a different question.

| Carrier | Type | Sharing | Note |
|---|---|---|---|
| `Entity.origin` | `SoftOrigin` | **SHARED**, `hub_name="git_origin"` | **the one origin field.** Folder, Artifact, Skill, Markdown, Project … all carry it here; pydantic types it |
| `Task.origin`, `MessageAttachment.origin`, `DataSource.origin` | `SoftOrigin` | PRIVATE re-declaration | a project/task origin is **cloned** by the receiver through its own action wire; an attachment's is a bundle pass-through |

Clone sites narrow with `as_git(entity.origin)` (`builtin/git_origin.py`) —
`None` for absent, non-git or malformed — instead of hand-rolling a validate.

## The wire contract

The hub pins a *released* `flow_sdk` and reads the git kind under the key
**`git_origin`**. That is the field's **`hub_name`** (`APIField(hub_name=...)`,
a `json_schema_extra` slot — never a pydantic alias, which would leak into the
API serializer and the disk header). `HubSerializer.body` renames every
`hub_name` field generically and drops any value whose `transportable` is
false (a `LocalOrigin`); `HubSerializer.unwire` / `from_payload` invert it on
the way back, and `membership_sync` goes through it. No kind strings anywhere.

Model dumps stay wire-stable (no `exclude_none`; `head_commit: null` rides):

```
git    kind, rel_path, provider, owner, name, branch, head_commit
local  kind, rel_path, base
```

## The bundle

One file at the bundle root, written by `_write_origin_files` and read by
`_read_origin_map`: **`fs_origins.json`** — every kind, keyed `<type>-<id>`,
values written through unchanged. An unreadable or absent file is `{}`, never a
failed unpack. The receiver reads `origins_map[key]` (or the entry payload's
`origin`) and stamps the typed value onto `entity.origin`.

## Adding a kind

1. Subclass `FSOrigin` with a `Literal` `kind` and your locator fields. Do not
   reorder inherited fields.
2. Add a `Tag` arm to `OriginField`.
3. Implement and register an `FSOriginDriver`. `key()` must be
   machine-independent, or shared assets will not reconcile.
4. Decide `transportable`. A machine-local origin overrides it to `False`;
   the share path gates on that, not on `kind`.
5. `detect()` currently hardcodes git, so a new kind is declaration-only until
   that grows a dispatch loop.

**Key source files:** `flow_sdk/fs_store/origin/{fs_origin,git_origin,local_origin,cloud_origin,field}.py`
(under `fs_store` so `entity_model` can type the field at class-build time),
`flow_sdk/builtin/fs_origin_driver.py`,
`flow_sdk/builtin/drivers/` (git/local drivers), `flow_sdk/assets/git_origin.py`
(`PortableGitOrigin`, publish/receipt only), `flow_sdk/builtin/flow_message_bundle.py`
(`_write_origin_files`, `_read_origin_map`)

## Related

- [Record model](record-model.md) — the `FSRecord` manifest an origin is stamped onto
- [Asset capsules](asset-capsules.md) — identity capsules and `TypeInfo.mint_entity_id`
- [Messages and attachments](../collab/messages-and-attachments.md) — bundle transport
- [Sharing and sync](../collab/sharing-and-sync.md) — the share paths that carry origins
- [FSRef](../fs-ref.md) — the *local* path reference; an origin is the remote one
