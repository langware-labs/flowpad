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
FSOrigin                         kind · rel_path · project_id
  ├── GitOrigin   kind="git"     provider · owner · name · branch · head_commit
  └── LocalOrigin kind="local"   base

FSOriginField = Annotated[Union[GitOrigin, LocalOrigin], Discriminator(resolve_origin_kind)]
```

`rel_path` is the universal placement contract — the asset **root** relative to
the origin's root (a folder for folder-layout types, a file for file-layout
types). `.` means the whole repository.

**The discriminator is tolerant by design.** A dict with no `kind` reads as
`git`, because origins persisted before the discriminant existed were all git.
That rule lives in exactly one place, `resolve_origin_kind`, and is shared by the
union and by `is_legacy_visible_origin`.

Store an origin in a field typed `FSOriginField`, never bare `FSOrigin` — a
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

| Carrier | Type | Sharing | Why this type |
|---|---|---|---|
| `Folder.origin`, `Artifact.origin` | `FSOriginField` | — | genuinely polymorphic: a folder may be a checkout **or** a mounted directory |
| `Project.git_origin` | `GitOrigin` | PRIVATE | a project origin is **cloned** — `clone_url()`, `branch`, `next_clone_target` at ~15 sites. A local-kind project origin is meaningless |
| `Task.git_origin` | `GitOrigin` | PRIVATE | same: the receiver clones it. Frontmatter-populated, no Python writer |
| `Entity.git_origin` | `dict` | **SHARED** | the **hub wire format** — see below. Must stay a dict |
| `MessageAttachment.git_origin` | `dict` | PRIVATE | a raw bundle pass-through buffer, re-wrapped into an origins map on restore |

So when adding a **new kind**, the homes that matter are the `FSOriginField`
fields. `Project` and `Task` are deliberately narrow, and widening them to the
union would only add `kind == "git"` narrows at every call site.

## The wire contract

`Entity.git_origin` is `Sharing.SHARED` and reaches the **hub**, which pins a
*released* `flow_sdk`. The serialized dict is therefore a wire format whose
exact key set **and key order** are load-bearing:

```
git    kind, rel_path, project_id, provider, owner, name, branch, head_commit
local  kind, rel_path, project_id, base
```

`head_commit: null` is emitted — there is no `exclude_none`. All three dump
paths (`model_dump(mode="python")`, `mode="json"`, `FS_ORIGIN_ADAPTER.dump_python`)
agree byte-for-byte, which is what lets internal code carry typed objects while
the boundary keeps dumping dicts.

**Forbidden, because each silently changes bytes:** adding `exclude_none` /
`exclude_defaults` / `by_alias`; reordering a field declaration. Field order for
the redeclared `kind` comes from the **base** class, so moving `kind` inside a
subclass is a byte change.

### validate → dump is not identity

A legacy kind-less dict round-trips with `kind`, `project_id` and `head_commit`
**added**, and reordered:

```
in   {provider, owner, name, branch, rel_path}
out  {kind:"git", rel_path, project_id:"", provider, owner, name, branch, head_commit:null}
```

That is correct behaviour, and it is why **any path that passes a raw origin
dict through to the wire must keep passing it through**. Normalizing such a path
"for consistency" rewrites bytes a released receiver is already reading.
`tests/unit/test_fs_origin.py` pins this asymmetry deliberately.

## Origins in a bundle

Two files at the bundle root, written by `_write_origin_files` and read by
`_read_origin_map`:

| File | Contents |
|---|---|
| `fs_origins.json` | canonical — **every** kind, keyed `<type>-<id>` |
| `git_origins.json` | transition dual-write — a strict subset |

The reader prefers the canonical file and falls back to the legacy one, so a
bundle from an older sender still unpacks; an unreadable file is treated as
absent rather than fatal.

The legacy file is the only thing keeping git shares readable by an
already-released receiver. **What may appear there is a property of the kind**,
answered by `is_legacy_visible_origin` in `fs_origin.py` — deliberately phrased
as a question about the kind so a new kind cannot inherit exclusion silently.
An old receiver can only materialize git, so anything else must stay out.

## Adding a kind

1. Subclass `FSOrigin` with a `Literal` `kind` and your locator fields. Do not
   reorder inherited fields.
2. Add a `Tag` arm to `FSOriginField`.
3. Implement and register an `FSOriginDriver`. `key()` must be
   machine-independent, or shared assets will not reconcile.
4. Answer `is_legacy_visible_origin` — almost certainly *no*.
5. Decide `transportable`. A machine-local origin overrides it to `False`;
   the share path gates on that, not on `kind`.
6. `detect()` currently hardcodes git, so a new kind is declaration-only until
   that grows a dispatch loop.

**Key source files:** `flow_sdk/builtin/fs_origin.py`, `fs_origin_field.py`,
`fs_origin_driver.py`, `git_origin.py`, `local_origin.py`,
`flow_sdk/builtin/drivers/` (git/local drivers), `flow_sdk/assets/git_origin.py`
(`PortableGitOrigin`, publish/receipt only), `flow_sdk/builtin/flow_message_bundle.py`
(`_write_origin_files`, `_read_origin_map`)

## Related

- [Record model](record-model.md) — the `FSRecord` manifest an origin is stamped onto
- [Asset capsules](asset-capsules.md) — identity capsules and `TypeInfo.mint_entity_id`
- [Messages and attachments](../collab/messages-and-attachments.md) — bundle transport
- [Sharing and sync](../collab/sharing-and-sync.md) — the share paths that carry origins
- [FSRef](../fs-ref.md) — the *local* path reference; an origin is the remote one
