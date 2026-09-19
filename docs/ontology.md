---
id: 34e4f26a-5e06-47fa-8c37-5250bfd397f7
version: 2
---
# Ontology — type, subkind, kind

Three words, three jobs. They are the join keys between the entity layer and the
shape layer, and today they are used interchangeably in places — this document
is the ground truth they get aligned to.

## The three words

| word          | vocabulary                                                    | selects                                      | example                |
| ------------- | ------------------------------------------------------------- | -------------------------------------------- | ---------------------- |
| **`type`**    | closed — the one registry (`EntityType`, 87 values)           | a class, system-wide: a row, a URL, a folder | `task`                 |
| **`subkind`** | closed, per type — an enum                                    | a variant *within* that type                 | `group`                |
| **`kind`**    | **open** — dot-path, one grammar (`flow_sdk/tags/grammar.py`) | anything in the ontology, across types       | `ingest.message.slack` |

A *type* is a join key. A *subkind* is a discriminator. A *kind* is an ontology
entry — the only one of the three that is open, prefix-matchable
(`tag_is_within`, glob subscriptions) and extensible without an SDK release.

## Composition

1. **An entity's** **`kind`** **is derived:** **`<type>.<subkind>`.** Never authored, never
   stored.
2. **An entity's** **`kind`** **is its own. The kind of what it carries belongs to what
   it carries.** A payload's kind lives on the payload
   (`Tagged[Payload].spec_kind`), not denormalised onto the row.
3. **A shape's kind is its ontology key.** `spec_kind` *is* a kind; the prefix is
   historical and goes away once rules 1–2 free the word on entity rows.
4. **An** **`asset_spec`'s kind is its type name**, derived. An explicit declaration
   registers an *alias*, nothing more.

## Namespaces

A kind belongs to whoever minted it. The marker is the existing first-segment
form, already implemented in both twins
(`tags/grammar.py:33`, `ts_sdk/src/tags/grammar.ts:26`):

```
--acme--.ingest.message.whatsapp      an external definition
ingest.message.whatsapp               ours
```

**`--flow--`** **is never written.** The flow ontology is the default and it is
silent: an unmarked kind is ours, everywhere, with no exceptions. Nothing in the
tree should ever contain the literal `--flow--` — a grep for it is a lint.

Anyone may mint a namespace. There is no allocation, no registry and no
approval; we validate the *shape* of the marker, never the claim. Two externals
colliding on `--acme--` is contained inside their own subtree and can never
reach ours.

## Who declares a namespace

**A project declares it once; every asset under it inherits it.**

```json
// <project root>/agentic-assets/project_manifest/project_manifest.json
{ "schema": 1, "ns": "acme", ... }
```

* `flowpad_assistant` declares `flow` — **once, in one file.** Its \~40 shipped
  assets say nothing, and the kinds they mint come out unmarked.

* A project that declares nothing inherits `flow` only if it is the system
  project; any other project must declare before it can publish.

* The declared value is **stamped into each asset's own** **`<entity>.json`** **on
  publish**, so an asset that travels alone (hub one-click install, skill share,
  artifact install) keeps its namespace. The project manifest is the source of
  truth while authoring; the stamp is what survives the journey.

* A namespace is **frozen at first publish**. Changing it afterwards re-keys
  every kind the asset ever minted.

## Coverage — every path a kind is minted

| # | path                                                                                                | where the namespace comes from                                                        |
| - | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1 | `DataSpec.__pydantic_init_subclass__` (`spec.py:93`) — any spec class, on import                    | the project owning the module; SDK modules ⇒ flow                                     |
| 2 | `register_builtin_kinds()` (`_kinds.py`) — explicit SDK kinds (`fs_ref`)                            | always flow                                                                           |
| 3 | an asset loaded from a folder — `load_driver(folder)`, and the lazy `add_kind_loader("ingest.", …)` | the asset's project; `DataDriver.shipped` already distinguishes shipped from external |
| 4 | an `asset_spec` registered under its type name (new, rule 4)                                        | the type's own project                                                                |

Paths 1 and 3 are the same mechanism: loading an asset imports its module, and
the class declaration is what registers. That is the design's one hard problem —
see below.

## Open questions — decide before implementing

1. **Path 1/3 has no project context at class-definition time.**
   `__pydantic_init_subclass__` fires when the module is imported and knows
   nothing about which asset folder it came from. Two candidate fixes: the loader
   sets a context variable around the import, or the loader re-registers the
   asset's classes under its namespace after import. The first is simpler and
   racy under concurrent imports; the second is explicit and costs a second pass.
2. **An external that declares no namespace.** Reject at load, mint one from the
   asset's identity, or allow unmarked. Rejecting is loud and breaks nothing
   today — every asset in the tree is system-scope — but it is a hard gate on
   whatever exists in the wild.
3. **`ns`** **in the project manifest requires the manifest to exist.** It is written
   on publish today; nothing in the tree carries one. Creating it when a project
   first authors an asset avoids re-keying, but adds a file to a flow that does
   not have one.
4. **Registry keys are not covered.** `Capability.kind` and `DataDriver.kind`
   hold a driver's own name — neither a self-kind nor a payload kind. They need a
   word of their own, or `name`.

## Invariants

* One name, one binding — registering a kind already bound to a different class
  is an error, not a silent overwrite.

* An unresolvable kind is an error at registration, not `Any` at resolution.

* `--flow--` never appears in a kind string, a file, or a test fixture.

