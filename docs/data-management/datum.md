# Datum — the data descriptor and carrier

`Datum` (`flow_sdk/schema/datum.py`) is the most basic unit of data in the
system: it **describes** a shape and it **carries** the values. One model does
both, because they are the same tree — empty leaves make it a contract,
populated leaves make it the datum.

It is for data whose shape arrives **as data** — an asset manifest, a dataset
row, an I/O contract someone wrote in JSON. It sits at the bottom of the schema
layer, beside [the schema registry](schema-registry.md).

```python
class Datum(BaseModel):
    kind:   Optional[str]                = None   # a dot-path tag
    fields: Optional[Dict[str, "Datum"]] = None   # branch
    value:  Any                          = None   # leaf
```

Three optional fields and one invariant: **`fields` XOR `value`** — a node is a
branch or a leaf, never both.

## Descriptor and carrier are one tree

A schema describes and an instance carries; here they are the same shape. With empty leaves it is a **contract**; with populated
leaves it is the **datum**:

```jsonc
// contract
{ "kind": "content.data.classification",
  "fields": { "category": { "kind": "string" }, "score": { "kind": "float" } } }

// datum
{ "kind": "content.data.classification",
  "fields": { "category": { "value": "invoice" }, "score": { "value": 0.91 } } }
```

They join **by position**, not by matching kinds. That is what makes comparing a
produced value against an expected one a structural walk rather than a schema
negotiation — walk both trees, compare leaves.

## Scope — what this is NOT for

Shapes declared in **source** stay Python annotations. `APIField` carries policy
(`sharing`, `persist`, `blob`), not type — the type is the annotation beside it,
and Pydantic already gives it validation, serialization and static checking. A
runtime tree would be a strict downgrade there.

Reach for `Datum` only where no class can exist because the shape is authored or
discovered at runtime.

Also out of scope, each for a stated reason: provider mirrors (Claude Code's
`--agents` JSON, MCP tool schemas — the format is not ours), the bus envelope's
`data` (deliberately opaque: *identity and a locator, never content*), and frozen
wire formats such as `Entity.git_origin` (key set **and order** are load-bearing
to a released hub).

## `kind`

An ordinary dot-path tag, validated by the one grammar
(`flow_sdk/tags/grammar.py` `normalize_tag`) — the same namespace bus tags and
`kind` fields already share. It is **optional at every node**: a leaf's field
name usually labels it well enough, and an un-annotated node is a legitimate
state — routable and composable, just not validatable.

It is adopted (normalized) on write, because reads are strict: a raw kind stored
here would raise later inside `kind_matches`, at a point that cannot explain
itself.

`kind` earns its keep at **reference leaves**, where it says how to read a value
that is a pointer rather than the thing itself. Reuse a kind that the tag seed
already carries (`flow_sdk/builtin/tag.py` `SYSTEM_TAG_SEED`) rather than minting
a private one — a kind that is not in the seed has no label, no description, and
no place in the tag tree:

| `kind` | `value` is |
|---|---|
| `content.file` | a relative path — read the bytes |
| *(absent)* | the datum itself, or opaque |

## Repetition

**Repetition is sibling keys, not a list.** The dataset walker emits
`output-1`, `output-2` as separate keys, and key order carries the ordering.
That keeps a contract and its datum the same shape, so the position-join holds.

A leaf's `value` is `Any`, so it *can* hold a list — but a list is opaque to
`leaves()`, which means a contract describing one cannot join to an instance
containing one. Do not use a list where the elements need to be addressed
individually.

Picking a real repetition primitive (an ordered `items:` arm whose paths carry
an index) is open, and it is the decision that gates describing list-valued
config fields.

## Not an entity

No `id`, no `digest`. A `Datum` is a value object. Identity and freezing belong
to whatever *stores* an instance — a dataset `Example` has an id; its tree does
not.

## Reading a tree

```python
node.is_leaf                     # branch or leaf
node.fields["output-1"]          # children are addressed by key
node.leaves()                    # yields (path, node) depth-first — path IS the join key
```

## Where it is used

| Site | Carries |
|---|---|
| `Example.datum` (`flow_sdk/builtin/dataset.py`) | one dataset row, mirroring its example directory |

Planned: an agent-spec I/O contract, `dataset.json`'s `schema` slot, and the free
`data` sections the type system has never been able to see.

Not planned, and worth stating: the ingest manifest's `ConfigField` is eight
parts form policy (`required`, `label`, `hint`, `placeholder`, `advanced`,
`pattern`, `default`, `account_key`) to one part type. A `Datum` has nowhere to
put policy — the same reason `APIField` is out of scope. At most it could
describe the *value* such a field holds, with the policy staying where it is.

## Adjacent, not yet folded in

`CapabilityValue` (`flow_sdk/core/capabilities/models.py`) is `kind` + `value` +
`value_type`, validated against the same tag grammar — an independently invented
flat version of a `Datum` leaf. If `Datum` is the one descriptor, that is the
sibling that should eventually fold into it.

## Related

- [Schema Registry](schema-registry.md) — per-type registration; `TypeInfo` is
  the resolver for entity-backed kinds, a layer above this one
- [Dataset Layout](datasets.md) — the on-disk grammar that produces an
  `Example.datum`
- [Tags](../tags.md) — the taxonomy `kind` draws from
