---
id: 34e4f26a-5e06-47fa-8c37-5250bfd397f7
version: 2
---
# Ontology — type, subkind, kind

Three words, three jobs. They are the join keys between the entity layer and the
shape layer. This document is the ground truth they are aligned to.

## The three words

| word          | vocabulary                                                    | selects                                      | example                |
| ------------- | ------------------------------------------------------------- | -------------------------------------------- | ---------------------- |
| **`type`**    | closed — the one registry (`EntityType`)                      | a class, system-wide: a row, a URL, a folder | `task`                 |
| **`subkind`** | closed, per type — an enum                                    | a variant *within* that type                 | `group`                |
| **`kind`**    | **open** — dot-path, one grammar (`flow_sdk/tags/grammar.py`) | a SHAPE, across types                        | `ingest.message.slack` |

A *type* is a join key. A *subkind* is a discriminator. A *kind* is an ontology
entry — the only one of the three that is open, prefix-matchable
(`tag_is_within`, glob subscriptions) and extensible without an SDK release.

## A kind always names a `DataSpec`

This is the rule the rest follows from, and it was not true before.

A type name used to resolve through a fallback to the **Entity class**
(`kind_type` → `_types[kind].entity_cls`). So the same authoring form meant two
different things:

```python
parse("compute_op")  -> ComputeOpSpec   # a document SHAPE — that spec declared a spec_kind
parse("task")        -> Task            # a database ROW model
```

A row model is not a `DataSpec`. A `SpecType` field holding one cannot validate a
value against it — it would demand ids and DB columns the value has never heard
of. So the fallback is gone and an asset type resolves to its **`asset_spec`**,
its document shape, derived from the type name and never declared twice.

A registered type with **no** asset document names no shape: `resolve_kind`
raises rather than answering `Any`, because the author meant a real thing.
A name nobody has registered stays anonymous (`Any`) — eager compilation's
forward references depend on that.

## Composition

1. **An entity's** **`kind`** **is derived:** **`<type>.<subkind>`.** Never authored, never stored.
2. **An entity's** **`kind`** **is its own. The kind of what it carries belongs to what
   it carries** — a payload's kind lives on the payload (`Tagged[Payload]`), not
   denormalised onto the row.
3. **A shape's kind is its ontology key.** `spec_kind` *is* a kind; the prefix is
   historical and goes once rules 1–2 free the word on entity rows.
4. **An** **`asset_spec`'s kind is its type name**, derived. An explicit declaration
   registers an *alias* — `ingest.source_item`, `mcp.server`, `project.manifest`
   keep working, and both spellings resolve.
5. **Only a class's OWN** **`spec_kind`** **registers.** An inherited one is not a new
   kind: `FileDataPage` inherits `source.page` from `DataPage` and used to
   rebind it, so the name resolved to the narrower subclass.
6. **A kind names exactly one shape.** Rebinding raises; it used to be silent,
   and whichever class the process imported second won.

## Namespaces

A kind belongs to whoever minted it. The marker is the grammar's existing
first-segment form, already in both twins (`tags/grammar.py:33`,
`ts_sdk/src/tags/grammar.ts:26`):

```
--acme--.ingest.message.whatsapp      an external definition
ingest.message.whatsapp               ours
```

**`--flow--`** **is never written.** The flow ontology is the default and it is
silent: an unmarked kind is ours, everywhere. The literal never appears in a kind
string, a document or a fixture.

Anyone may mint a namespace. No allocation, no registry, no approval — we
validate the *shape* of the marker, never the claim. Two externals colliding on
`--acme--` is contained in their own subtree and can never reach ours.

## Who declares, and how it is found

**A project declares it once; its assets inherit.** An asset carries its own only
when it must differ.

* **`Project.ns`** — the authoring surface: one field covering every asset in the
  project.

* **The asset document's** **`ns`** — what the resolver actually reads, and what lets
  an asset that travels alone (hub one-click install, a shared skill) keep its
  namespace outside the project that authored it.

The split is forced, not stylistic: a Project row lives in the database, and
kinds register at class-definition time, where there is no database and may not
yet be a running server. The row is where a human declares; the file is where the
resolver looks.

### Resolution — a walk up from the class's own file

`flow_sdk/schema/data_spec/_namespace.py`. A class resolves its own namespace at
definition time from its own file (`cls.__module__` → the module's `__file__`,
which the import machinery sets before the class body runs). Walking up, the
first top-level `*.json` declaring an `ns` wins; nothing found means ours.

Matching on the document's *name* (`<family>/<name>/<family>.json`) was the
obvious rule and is wrong: `load_driver` accepts any folder holding a
`data_driver.json`, canonical layout or not, so a name rule would namespace an
asset in its shipped home and silently miss the same asset anywhere else.
**Declaring** **`ns`** **is the opt-in; the filename is not.**

No context variable, no ordering dependency, no second pass, no database. A
module nested inside an asset (`data_driver/x/transport.py`) walks up to the same
answer; a shared SDK module imported *by* an external driver resolves to ours,
correctly, because its own path answers for it.

A namespace is **frozen at first publish**: changing it re-keys every kind the
asset ever minted.

## An external must name its ontology

`load_driver` refuses a driver outside the shipped tree that declares no `ns` —
**before** importing `source.py`, because the import is what mints the kinds.
Unnamed, an authored `whatsapp` declaring `ingest.message.whatsapp` would collide
with the shipped one and one of them would lose in silence.

## Coverage — every path a kind is minted

| # | path                                                                                    | namespace                                     |
| - | --------------------------------------------------------------------------------------- | --------------------------------------------- |
| 1 | `DataSpec.__pydantic_init_subclass__` (`spec.py`) — any spec class, on import           | the walk above                                |
| 2 | `register_builtin_kinds()` (`_kinds.py`) — explicit SDK kinds (`fs_ref`)                | always ours                                   |
| 3 | an asset loaded from a folder — `load_driver`, the lazy `add_kind_loader("ingest.", …)` | the walk; refused when an external names none |
| 4 | an `asset_spec` registered under its type name (rule 4)                                 | the type's own project                        |

Paths 1 and 3 are one mechanism: loading an asset imports its module, and the
class declaration is what registers. The walk is what makes that safe.

## Not yet done

* `Project.ns` is not wired, and nothing stamps a project's namespace into its
  assets' documents. Until it is, an asset declares its own `ns` or is ours.

* `ns` is declared on `DataDriverSpec` only. `AssetDocumentSpec` is
  `extra="ignore"`, so an `ns` key in any other asset document is read by the
  resolver but dropped by the model; declaring it there means mirroring the field
  onto 14 entity classes (`check_asset_spec` enforces it).

* Rules 1–2 (`subkind`, derived `kind`, payload-kind) are unimplemented. The
  blockers: `Conversation.kind` is a two-repo change gating hub authorization,
  `FlowMessage.kind` is on the wire, and `SourceItem.kind` is first in
  `DIGESTED_FIELDS` so changing its value re-digests the corpus.

