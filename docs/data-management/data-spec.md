---
id: cdd25916-d86c-4c47-984a-db8a7c25cc85
---

# DataSpec — shape as Pydantic, the spec as the layout

Two things the schema layer needed and did not have: a way to describe data
whose shape **arrives as data**, and a way for an asset's on-disk layout to be
**the class that models it**. Both live in `flow_sdk/schema/data_spec/`.

The ruling behind both: **the shape is Pydantic, period.** A shape declared in
source is a `DataSpec` subclass. A shape that arrives at runtime is *compiled
to* a `DataSpec` subclass. One type system, not two — and the carrier is plain
JSON, never a wrapper.

## `DataSpec` — the base of every shape

```python
class DataSpec(BaseModel):
    spec_kind: ClassVar[str] = ""      # the shape's name in the tag ontology; "" ⇒ anonymous
    model_config = ConfigDict(extra="forbid")
```

Everything that describes data inherits from it — `ExampleSpec`, `DatasetSpec`,
the three leaves, a user's `class EmailInput(DataSpec)`, and every shape parsed
from YAML. A field typed `DataSpec` means "any shape."

### Declared in source

```python
class EmailInput(DataSpec):
    spec_kind = "email.message"        # a bare assignment — NOT an annotation
    subject: str
    body: str
```

Subclassing **registers** the class under its kind in the one `SchemaRegistry`
(`__pydantic_init_subclass__` — the hook that sees `model_fields`). Two rules,
both enforced: `spec_kind` must stay a `ClassVar` (annotating it makes it a
field, and the guard — an `assert` in the hook — trips at class creation); and a
Pydantic **parametrization** (`ExampleSpec[A, B]`) inherits its origin's kind and
deliberately does not register — only a *named* subclass does.

Registration is import-time, and forgetting it fails silently: a kind whose
module nobody imported resolves to `Any`. `register_builtin_kinds()`
(`data_spec/_kinds.py`) is the one place that makes the SDK's own kinds
reachable — it binds `fs_ref` to `FSRef` and imports `dataset_spec`
(`file_ref` / `folder` / `text`), `llm_source_spec` (`llm.source`) and
`mcp_spec` (`mcp.server`); `SchemaRegistry` calls it at registration.
`ingest.source_item` registers when `flow_sdk/builtin/source_item.py` is
imported — `register_all()` reaches it through `source_item_type_info`, so it
is bound before any manifest's `spec` is parsed.

### Arriving as data — `DataSpec.parse`

The authoring form has **no keywords**. It mirrors a Python annotation
one-to-one, and those are the only three shapes an annotation can take:

| authored (JSON / YAML) | annotation it mirrors | `parse` returns |
|---|---|---|
| `"string"` — a bare kind | `str` | `resolve_kind("string")` |
| `{"category": "string", …}` — an object | `class X: category: str` | an anonymous `DataSpec` subclass (`create_model`) |
| `["string"]` — a one-element list | `list[str]` | `list[T]` |

A dict is **always** an object whose keys are field names. That is why the
registration hook is `spec_kind`, not `kind`: a user must be free to author a
field called `kind`. Identical object forms share one compiled class, and the
class remembers the (normalized) form it came from, so it dumps back to exactly
what was written — that is what keeps `agent.md` and `dataset.json` readable.

### `spec_kind` is the connector

An ordinary dot-path tag (`flow_sdk/tags/grammar.py`), resolved through the
**one** `SchemaRegistry`: a reserved primitive (`string` `int` `float` `bool`)
→ its Python type; a registered kind → its class (`register_kind` /
`kind_type` / `kind_for`; entity type names live in the same table, so
`"dataset"` is a kind); anything else → **anonymous**: `Any`. Legal, opaque,
never minted. A kind referenced before it is registered resolves to `Any` —
compilation is eager, so there is no cycle to detect.

### A shape held by a field — `SpecType`

A shape is a *class*, and a class is not a Pydantic value: a field that holds
one is typed `SpecType` (`Annotated[type, BeforeValidator(parse),
PlainSerializer(to_authoring_form)]`), declared `Optional[SpecType]` when it may
be absent — Pydantic short-circuits `None` OUTSIDE the `Annotated`, so neither
hook ever sees it. The validator reads the authoring form; the serializer emits
it back. `Agent.input`/`output` and `CapabilitySpec.value_spec` are `SpecType`
fields; `DatasetManifestSpec.spec` / `Dataset.spec` are the sibling
`DatasetSpecType` (`flow_sdk/builtin/dataset.py`), whose validator is
`DatasetSpec.parse` — the keyword form — and whose serializer is the same
`to_authoring_form`. The record writer (`fs_record._json_default`) encodes a
class the same way.

### Deliberately not in this cut

Optional fields (every declared field is required; the least-invented later
extension is a trailing `?` on the field *name*) and self-referential kinds.

## `ExampleSpec` / `DatasetSpec` — typed by generics

`Spec` is the suffix for a **value model** — not an entity, never a row of its
own. The one entity is `Dataset`.

```python
class ExampleSpec(DataSpec, Generic[I, O, C]):
    id: str; kind: ExampleKind                    # `kind` is the ROW role — a field
    input: I
    output: O | list[O] | None                    # numbered occurrences on disk → list[O]
    ground_truth: O | list[O] | None              # the gold answer — the SAME shape as output
    context: C | None
    metadata: dict; data: dict                    # example.json sections ∪ sidecars by filename

class DatasetSpec(DataSpec, Generic[E]):
    examples: list[E]
```

`DatasetSpec[MyExample]` validates every row as `MyExample` — a dataset can be
**typed by the agent that produced it**. The bare generics are refused
(Pydantic would otherwise silently validate against the TypeVar *bounds*).
An input-only row is legal: unlabeled, or not yet run.

Three built-in leaves say what a slot holds when it is a file, a folder, or a
CSV cell — **the type IS the file/folder distinction**:

```python
class FileRef(DataSpec):    spec_kind = "file_ref"; path: str            # example-relative POSIX; resolved by the layout
class FolderSpec(DataSpec): spec_kind = "folder";   path: str; files: dict[str, FileRef | FolderSpec]
class TextSpec(DataSpec):   spec_kind = "text";     text: str
```

`FolderSpec.files` is the precedent for a `dict` field on a spec: the authoring
form has no map type, so a `dict[...]` field is expressible ONLY on a class that
carries a `spec_kind` — `to_authoring_form` short-circuits on the kind before it
would fail with `no authoring form for ...`. The three leaves are the untyped
default slot (`Artifact = FileRef | FolderSpec | TextSpec`).

The keyword authoring form lives in `dataset.json` (see
[datasets.md](datasets.md)) and compiles to `DatasetSpec[ExampleSpec[I, O, C]]`.

## `DatasetLayout` — the one thing that knows the disk

`ExampleSpec` is a value; it never learns whether it came from a CSV row or a
folder of files. A layout does: `read(folder, spec) -> list[E]` turns the disk
into typed rows, `write(folder, examples)` turns rows back. `CsvLayout` and
`FolderLayout` are a 1:1 port of the old walker — the on-disk grammar is
unchanged, and the 74 grammar tests are its spec. `FolderLayout.write_example`
/ `write_example_meta` are the primitives the graph-workflow capture seam
(`prepare_execution_io`, `_stamp_example`) calls, so an execution directory IS
an example directory and the two writers cannot drift.

## The spec IS the layout — `TypeInfo.asset_spec`

One mechanism: a type's shape is a `DataSpec` registered as **`TypeInfo.asset_spec`**,
and the spec's field TYPES say what the document holds. There is no asset mixin
and no `header` ClassVar — the entity class is the row, its `APIField`s are the
columns, and the registry check (`check_asset_spec`) guarantees every spec field
is an entity field with a compatible core (the entity may narrow: `str` → `TypeId`,
`str` → a `StrEnum`).

| in the spec | on disk |
|---|---|
| a scalar field | frontmatter (`.md`) / the `metadata` section (`.json`) |
| `prompt: Body` | the markdown body — never in the header |
| `data: FreeSection` | the free `data` section of a two-section JSON manifest |
| `FileRef` / `FolderSpec` | bytes — a file, a directory |
| `list[ExampleSpec]` | rows, written by the `DatasetLayout` `TypeInfo.rows_layout_field` names |
| a field typed as another **asset type** | a sub-asset with its own identity — recognised by the REGISTRY (the nested class's type has an `asset_spec`), never by inheritance; a `list[…]` of a file-layout type is a directory of files |

```python
class SubAgentSpec(FrontMatter):            # a DataSpec with extra="ignore" (hand-edited file)
    name: str | None = None
    tools: Any = None
    prompt: Body = ""                       # ⇒ frontmatter + body

class DatasetManifestSpec(FrontMatter):     # dataset.json
    title: str | None = None
    data_layout: str | None = None
    data: Optional[FreeSection] = None      # ⇒ {"metadata": …, "data": …}

SUBAGENT = TypeMetadata(..., asset_spec=SubAgentSpec)
DATASET  = TypeMetadata(..., main_layout="folder", main_file="dataset.json", asset_spec=DatasetManifestSpec)
```

What `TypeInfo` still declares is **naming and placement**, not structure:
`main_layout` (a folder with no byte fields — `DataSourceSpec` — is a Claude
Code placement convention the spec cannot derive), `main_file`, `name_from_path`,
`hub_main_file`, the identity backend, and the DB medium's `natural_key` /
`digest_fields`. `FrontMatter` is the one `DataSpec` variant for disk documents
(`extra="ignore"`: an undeclared key in a hand-edited file is dropped, never an
error); a wire spec keeps `forbid`. A type with no `asset_spec` still goes
through the ONE `DiskSerializer`: it renders via `TypeInfo.default_body_fn` (a
template the spec vocabulary cannot express — `dynamic_workflow`'s `.js`) and
loads via `from_disk_fn` → record → entity.

Two more layout facts a spec cannot say live on `TypeInfo`: `manifest_layout`
(`"sections"` = `{metadata, data}` as a dataset writes; `"flat"` = the header's
keys merged onto the payload's own document, as a trace/report file is — a
`SectionedHeader` lifts/pushes fields under one nested key such as `summary`)
and `derive_fields_fn(data, root, header_raw)` — the facts the DISK carries
that the header cannot (counts over rows, wiki-links in a body, a name from the
path), applied by `load` before the row is built. The header dump is
`exclude_defaults`: a spec default is not authored, so a fresh doc has an empty
header and a counter is written only once it moved.

### Persistence is the serializer's

`flow_sdk/fs_store/serializer/` owns **how** and **where**. A `DataSerializer`
has `store(obj, origin: FSOrigin) -> FSOrigin` and `load(cls, origin)`; the
destination is resolved from `origin.kind` through a registry, exactly like
`FSOriginDriver`:

| origin | serializer | what it does |
|---|---|---|
| `LocalOrigin` (`"local"`) | `DiskSerializer` | frontmatter/JSON main doc + every `FileRef`/`FolderSpec`/sub-asset field; rows through `DatasetLayout` (`rows_layout_field`); commits identity via `mint_entity_id` at the end of `store`, observes it at the start of `load` |
| `DbOrigin` (`"db"`) | `DbSerializer` | the entity's `data` column dict |
| `HubOrigin` (`"hub"`) | `HubSerializer` | the share body (`_hub_body`) |

`TypeInfo.serializer(origin=None)` picks the default from `default_origin_kind`
(`"db"` for `db_only` types, else `"local"`); `Entity._store()` IS that call —
one writer, so `Dataset.save()` lands `dataset.json` and `data.csv` on disk.
An owned flat JSON doc whose payload is `None` renders nothing — a
metadata-only save never clobbers a report file.

A field the medium cannot hold — a `FileRef` reaching the DB or an HTTP body —
**raises `UnsupportedFieldError`**; it is never downgraded. The one
type→persistence mapping is `serializer/fields.py::field_persistence`.

The `asset_spec` is the disk policy; `TypeInfo.effective_meta_model` is derived
from it (`BaseMeta ∪ spec ∪ Persist.TRUE − Persist.FALSE`) so there is one field
policy per type. A row-only type (`db_only`) writes no shadow at all and feeds
FTS from the row (`FtsEntry.from_entity`). **`TypeInfo.fts_content`** is the one
FTS rule for every type: the named fields joined by newlines become the record's
`content` (asset types) or the FTS row (`db_only`).

### The contract, and the test that enforces it

**What the spec declares is what the disk holds, and nothing else.** A key the
spec does not declare is dropped on read (`extra="ignore"`) and never written.
`None` is absent, not `null`, and reads back as the field's default.

`tests/unit/test_data_spec/test_asset_roundtrip.py` is a **per-field matrix**:
for every migrated class it builds an instance with every field non-default,
stores it through `DiskSerializer`, loads it back, and fails on the first field
that did not survive — by name. It asserts `cls.model_fields`, not what its
author remembered. `test_db_roundtrip.py` / `test_hub_roundtrip.py` are the
same matrix for the other two media, including the raise cells.

### TypeInfo integration

A spec-bearing type needs **no `from_disk_fn`**: `SchemaRegistry.register`
defaults it to `spec_extractor(type)` (`fs_store/serializer/record.py`), which
resolves the asset root from the walker's ref (folder / inner main file / file
with `main_ext`), runs `serializer().load`, emits every declared field plus
`content` from `fts_content`, and anchors `asset_ref` via `asset_ref_for`. A
rejected file (bad manifest, binary under `.md`) is `[]`, never an indexer error.
Per-type facts live in `derive_fields_fn`; a hand `from_disk_fn` is only for a
type with no spec.

## Where it is used

| site | what |
|---|---|
| `Dataset.spec` / `Dataset.examples` | the dataset's shape (`DatasetSpec[…]`) and its rows (`list[ExampleSpec]`) |
| `Agent.input` / `Agent.output` | the agent's I/O contract as shape CLASSES — `input + template → output`. Declaration only: never in `to_agent_options` (md5'd into `last_started_hash`) |
| `CapabilitySpec.value_spec` / `CapabilityValue.spec` | the shape of a capability's discovered value (`fs_ref`); `value_type` is the spec's kind |
| `prepare_execution_io` / `_stamp_example` | the capture seam, writing through `FolderLayout` |
| `AgentSpec`, `SubAgentSpec`, `DatasetManifestSpec`, `ManifestSpec`, `SourceItemSpec` | the `asset_spec` of Agent / SubAgent / Dataset / DataSourceSpec / SourceItem |
| `SpecDocSpec`, `PromptSpec`, `SkillSpec`, `MarkdownSpec` / `ClaudeMdSpec`, `TaskSpec` | the `asset_spec` of the `.md`-backed types — `TaskSpec` is also the share whitelist |
| `AgentTraceSpec`, `UsageReportSpec`, `AssetCleanupReportSpec` | flat JSON reports (`manifest_layout="flat"`, a `FreeSection` payload; `SectionedHeader` for `summary`/`data`) |
| SOURCE_ITEM `asset_spec` = `SourceItemSpec` | the ingestion envelope a driver emits; the DB medium resolves the row by `TypeInfo.natural_key` and no-ops on `TypeInfo.digest_fields` |
| DATA_SOURCE_SPEC `asset_spec` = `ManifestSpec` | `data_source.json` — a FLAT manifest (no `FreeSection`), every authoring rule a validator |

## Related

- [Schema Registry](schema-registry.md) — `register_kind` / `kind_type` / `kind_for`
- [Dataset Layout](datasets.md) — the on-disk grammar and the `spec` authoring form
- [Tags](../tags.md) — the taxonomy `spec_kind` draws from
