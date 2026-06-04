---
id: 22c01d21-5edd-5954-af6e-237e445a5d95
---

# Entities Groups — generic folder-like containment

A `Group` is a generic container entity: it acts like a folder for other
entities. Pure organization — no execution semantics, no permissions. Any
entity can be placed in exactly one group; groups nest; every group tree is
browseable through the existing browseable-tree infrastructure exactly like
the docs menu.

This is the **lower level**: all folder mechanics (create / rename / move /
delete / membership / browse adapter) live here. Features that want a
"library of X in folders" (see `prompt-library.md`) compose this layer and
contain zero folder logic of their own.

## Model

```
            namespace = "prompt-library"            (tree identity, on Group only)

   (virtual root: group_id == null)
        |
        +-- Group{name:"Reviews", namespace, group_id:null}
        |        |
        |        +-- Group{name:"Deep", namespace, group_id:^}     <- nesting = same field
        |        |        |
        |        |        +-- prompt{..., group_id:^}              <- member
        |        +-- prompt{..., group_id:^}
        |
        +-- prompt{..., group_id:null}                             <- root-level member
```

- **Membership = `group_id` on base `Entity`** (nullable, default null, persisted,
  indexed). Child points up — exactly one parent, like a real folder. Moving an
  entity between folders is a single field write. No member arrays anywhere
  (deliberate: reflected shrinking arrays are a known corruption class — see
  `deepAssign` notes in `prompt_queue.md`).
- **Nesting is the same mechanism**: `Group` is an entity, so its parent is its
  own inherited `group_id`. There is no separate `parent_group_id`.
- **Roots are virtual.** A tree is identified by `namespace` (a string on Group
  only, e.g. `prompt-library`). Top level of a tree = groups with
  `{namespace, group_id: null}` plus member entities of the consumer-chosen
  leaf types with `group_id: null`. Members never carry a namespace — the
  consumer decides which types appear as leaves.
- **Scope**: groups and members are ordinary entities — `project_id` ancestry,
  indexing, and sharing mechanics apply unchanged. Nothing scope-special.

### Group entity (backend)

`flow_sdk/builtin/group.py` — replaces the dormant ACL `Group` in
`entity_model.py` (zero callers; its `get_public_group` is deleted with it).
Takes the existing `GROUP = "group"` type value (byte-stable).

```python
class Group(Entity):
    type: str = "group"
    name: str
    namespace: str                 # tree identity; immutable after create
    icon: str | None = None       # optional
    color: str | None = None      # optional
    # parent pointer: inherited Entity.group_id
```

Registration follows the standard pairing rule: schema type (exists) +
builtin entity + `schema/type_info/group_info.py`.

### Base Entity addition

```python
group_id: str | None = APIField(default=None)   # generic, types=all, indexed
```

Indexed in the entity/search index so children queries are one cheap lookup.

## Invariants

1. `group_id`, when set, must reference an existing `Group` (validated on
   every set; entity-id policy v4/v5 applies on adopt).
2. **No cycles**: re-parenting a group under its own descendant is rejected
   (backend walk-up check, bounded by max depth 64).
3. `namespace` is immutable after creation; a group cannot be moved across
   trees.
4. Deleting a group **moves its children up** (they inherit the deleted
   group's `group_id`). Cascade delete is deferred; v1 has no destructive
   recursion.
5. Group and member should share `project_id`; cross-project re-parenting is
   rejected.

## Interfaces

### Backend actions (folder mechanics live here)

| Action | On | Body | Behavior |
|---|---|---|---|
| entity create | `group` | `{name, namespace, group_id?, icon?, color?}` | standard create |
| entity save | `group` | `{name?/icon?/color?}` | rename / appearance |
| `POST group/<id>/move` | group | `{group_id \| null}` | re-parent, cycle-checked |
| `POST group/<id>/delete-group` | group | `{}` | move children up, delete |
| `GET group/<id>/children` | group | `?types=a,b` | one round-trip: `{groups: [...], members: [...]}` |
| `GET group/roots` | type-level | `?namespace=X&types=a,b` | the virtual-root listing (`group_id == null`) |
| `POST <type>/<id>/set-group` | **base Entity, types=all** | `{group_id \| null}` | membership move; validates target |

Every mutation ends with `notify_updated()` on the touched entity — the UI
reflects via the ordinary `data_op` path; nothing tree-specific is pushed.

### SDK (ts_sdk) — all frontend logic

`Group` TS entity (`name/icon/color/namespace/group_id` reflected) plus thin
action wrappers — the SDK is the only thing the UI calls:

```
Group.create({name, namespace, groupId?, icon?, color?})
Group.listRoot(namespace, {types})        -> {groups, members}
group.listChildren({types})               -> {groups, members}
group.rename(name) / group.setAppearance({icon, color})
group.move(parentGroupId | null)
group.deleteGroup()                        // move-up semantics
entity.setGroup(groupId | null)            // on APIEntity (generic)
```

No optimistic local state: mutations round-trip, state reflects back via
`data_op` (same convention as the prompt queue).

### Frontend (generic, zero logic)

- **`groupRoot(cfg)`** — one generic browseable adapter
  (`ui/src/components/browseable-tree/adapters/groupRoot.tsx`) implementing
  the existing `BrowseableRoot` contract (`browseable-tree/types.ts:29-96`):

  ```
  groupRoot({
    namespace,                 // which tree
    leafTypes,                 // entity types shown as leaves
    leafToBrowseable(entity),  // label/icon/pointer for a leaf
    onSelectLeaf?,             // picker mode: overrides navigation for leaves
    capabilities: { createFolder, rename, delete, move },
  })
  ```

  - `listChildren` → `group.listChildren` / `Group.listRoot` (folders first,
    name-asc).
  - Folder toolbar (per `capabilities`): New folder, Rename, Delete — each a
    one-line delegate to the SDK, then `refreshNode(parentId)`.
  - Drag-move via the existing `dragData`/`canDrop`/`onDrop` contract →
    `entity.setGroup` / `group.move`.
- **`BrowseableMenu`** — thin popover wrapper around `BrowseableTree` (the
  tree is panel-only today); generic, reusable by any picker.
- **`useGroupTreeRefresh(namespace)`** — hook, reactivity only: subscribes to
  group/member entity updates and calls `refreshNode(...)`. No state, no
  decisions.

Click semantics: the tree's invariant is click = navigate. In picker
embeddings the consumer overrides `onNavigate`/`onSelectLeaf` (the sanctioned
injection point); real navigation stays available as a leaf toolbar action.

## Layer borders (non-negotiable)

| Layer | Owns | Never does |
|---|---|---|
| backend | validation, cycle checks, move-up delete, children queries, persistence | UI shapes |
| ts_sdk | every action call, children fetch, types | rendering |
| hooks | reactivity (subscribe → refresh) | business decisions |
| tsx | rendering `Browseable` rows, delegating callbacks to SDK | logic of any kind |

## Testing

- pytest unit: set-group validation, cycle rejection, move-up delete,
  children listing (groups+members, type filter), namespace immutability.
- vitest source-contract: `groupRoot`/`BrowseableMenu` zero-logic pins (no
  fetch, no entity mutation outside SDK calls), mirroring
  `queue-zero-logic.test.ts`.

## Deferred (explicitly out of v1)

Manual ordering (name-sort only), cascade delete, multi-parent membership,
hub/cloud sync of groups, per-group ACLs.
