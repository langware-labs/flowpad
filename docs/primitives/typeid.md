---
id: f2544cbe-e0a8-45aa-8ea7-5417aaabf9f3
---

# TypeId Specification

A **TypeId** is the universal identifier format in flow-cli. It uniquely identifies any entity — database records, filesystem records, or resources — by combining an entity type with an identifier.

## Format

```
{type}-{id}
```

| Component | Description                                                                             |
| --------- | --------------------------------------------------------------------------------------- |
| `{type}`  | Entity type string, lowercase (e.g. `user`, `compute_node`, `agent`)                    |
| `-`       | Delimiter. Always the first hyphen — the split is on the **first dash only**.           |
| `{id}`    | Entity identifier. One of four formats (see [Identifier Formats](#identifier-formats)). |

The first-dash-only split is critical because UUID identifiers contain dashes themselves:

```
task-550e8400-e29b-41d4-a716-446655440000
     ↑ split here, not at later dashes

type = "task"
id   = "550e8400-e29b-41d4-a716-446655440000"
```

## Identifier Formats

The `{id}` portion supports four formats, classified by the `IdentifierType` enum:

### UUID

Standard UUID v4. The default for dynamically created entities.

| <br />         | <br />                                                                |
| -------------- | --------------------------------------------------------------------- |
| **Enum**       | `IdentifierType.UUID`                                                 |
| **Pattern**    | `[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}` |
| **Example**    | `user-550e8400-e29b-41d4-a716-446655440000`                           |
| **Validation** | `is_valid_uuid4()` (Python), `isValidUUIDv4()` (TS)                   |

Entities that don't specify an `id` on creation get a random UUID v4 assigned automatically (`DBBaseRecord.__init__`).

### Named (`@uname`)

Human-readable name prefixed with `@`. Used for well-known singleton entities.

| <br />         | <br />                                                |
| -------------- | ----------------------------------------------------- |
| **Enum**       | `IdentifierType.NAMED`                                |
| **Pattern**    | `^@([a-zA-Z][a-zA-Z0-9_-]*)$`                         |
| **Example**    | `agent-@local`, `user-@system`                        |
| **Validation** | `is_valid_named_id()` (Python), `isValidUName()` (TS) |
| **Parse**      | `parse_named_id("@local")` → `"local"`                |
| **Property**   | `typeid.uname` → `"local"` (without `@`)              |

The TypeScript `isValidUName()` also accepts `@{uuid}` (e.g. `@550e8400-...`) for entities whose uname is an external UUID. The Python side does not.

**Bootstrap entities** all use `@local`:

```
user-@local           The desktop user
project-@local        Default project
workspace-@local      Default workspace
agent-@local          Local Claude Code agent
compute_node-@local   Local machine
```

### Namespace Key

Hierarchical identifier with an uppercase namespace prefix and numeric index.

| <br />           | <br />                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------- |
| **Enum**         | `IdentifierType.NAMESPACE`                                                                  |
| **Pattern**      | `^([_a-zA-Z0-9]+)-(\d+)$`                                                                   |
| **Example**      | `workspace-WORKSPACE-123`                                                                   |
| **Validation**   | `is_valid_key()` (both)                                                                     |
| **Parse**        | `parse_key("WORKSPACE-123")` → `("WORKSPACE", "123")`                                       |
| **Construction** | `get_namespace_key("workspace", "123")` → `"WORKSPACE-123"`                                 |
| **Properties**   | `.namespace` → `"workspace"` (lowercased), `.key` → `"WORKSPACE-123"`, `.key_index` → `123` |

The TS implementation caps the numeric index at 10000.

### Property ID (`prop.value`)

Dot-delimited property-based lookup. Identifies an entity by a unique property value.

| <br />         | <br />                                                       |
| -------------- | ------------------------------------------------------------ |
| **Enum**       | `IdentifierType.PROP_ID`                                     |
| **Pattern**    | `^([_a-zA-Z0-9]+)\.([_a-zA-Z0-9]+)$`                         |
| **Delimiter**  | `.`                                                          |
| **Example**    | `user-email.john_doe`                                        |
| **Validation** | `is_valid_prop_id()` (both)                                  |
| **Parse**      | `parse_prop_id("email.john_doe")` → `("email", "john_doe")`  |
| **Properties** | `.prop_id_name` → `"email"`, `.prop_id_value` → `"john_doe"` |

### Unknown

Assigned when the identifier matches none of the above patterns. Python allows construction with `IdentifierType.UNKNOWN`; TypeScript rejects with an error.

**TS vs Python strictness gap:** This difference means a Python-created entity with an unusual ID (classified as `UNKNOWN`) will cause an error if the TypeScript frontend tries to construct a `TypeId` from it. There is no runtime validation or assertion preventing this mismatch — it is enforced by convention only.

## Identifier Resolution Priority

When classifying an identifier, both Python and TypeScript check in the same order:

1. UUID
2. Namespace key
3. Property ID
4. Named ID
5. Unknown (fallback)

This order matters because some strings could match multiple patterns.

## TypeId Class

### Python

**Canonical location:** `flow_sdk/fs_store/type_id.py`
**Backward-compat re-export:** `flow_sdk/api/type_id.py` (imports and re-exports from canonical location)

Plain Python class with `__slots__` for immutability. Not a Pydantic `BaseModel`, but provides Pydantic v2 compatibility via `__get_pydantic_core_schema__` and `__get_pydantic_json_schema__` hooks, so it works seamlessly as a Pydantic field type.

```python
class TypeId:
    __slots__ = ("_type", "_id")
    TYPEID_DELIMITER: ClassVar[str] = "-"
    PROPID_DELIMITER: ClassVar[str] = "."
```

**Construction:**

```python
# From string (splits at first dash)
TypeId("user-@local")

# From dict
TypeId({"type": "user", "id": "@local"})

# From kwargs
TypeId(type="user", id="@local")
```

**Properties:**

| Property           | Type                     | Description                           |
| ------------------ | ------------------------ | ------------------------------------- |
| `.type`            | `str`                    | Entity type                           |
| `.id`              | `str \| None`            | Raw identifier                        |
| `.identifier`      | `str \| None`            | Alias for `.id`                       |
| `.identifier_type` | `IdentifierType \| None` | Which format the id is                |
| `.uname`           | `str \| None`            | Name without `@` (Named only)         |
| `.namespace`       | `str \| None`            | Lowercased namespace (Namespace only) |
| `.key`             | `str \| None`            | Full key string (Namespace only)      |
| `.key_index`       | `int \| None`            | Numeric index (Namespace only)        |
| `.prop_id_name`    | `str \| None`            | Property name (PropId only)           |
| `.prop_id_value`   | `str \| None`            | Property value (PropId only)          |
| `.vfs_subfolder`   | `str`                    | `"entities/{type}-{id}"`              |

**Serialization:**

* `str(typeid)` → `"user-@local"`

* Pydantic JSON serialization via `__get_pydantic_core_schema__` → string format

* Pydantic validation accepts string (`"user-@local"`) or dict (`{"type": "user", "id": "@local"}`) input

**Equality & hashing:**

```python
TypeId("user-@local") == TypeId("user-@local")  # True (type + id match)
hash(TypeId("user-@local"))                       # hash of "user-@local"
```

**Static methods:**

* `TypeId.is_typeid(value)` → `bool` — checks if value is a valid TypeId

* `TypeId.to_typeid(value)` → `TypeId` — converts or raises `ValueError`

### TypeScript (`ts_sdk/src/models/TypeId.ts`)

```typescript
class TypeId {
  type: string;
  id: string;
  static readonly DELIMITER: string = '-';

  constructor(typeIdOrType: string | TypeId, id?: string)
}
```

**Construction:**

```typescript
new TypeId("user-@local")            // from string
new TypeId("user", "@local")         // from type + id
new TypeId(existingTypeId)           // copy
```

**Key difference from Python:** TypeScript validates strictly — `new TypeId("user-whatever")` throws if `"whatever"` doesn't match any identifier format. Python allows it with `identifier_type = UNKNOWN`.

**Additional TS methods:**

* `.toUrlString()` → `"user/@local"` (slash-separated, for URL paths)

* `.toJSON()` → same as `.toString()`

* `.equals(other)` → `boolean`

### Standalone helper (`ts_sdk/src/models/TypeId.ts`)

```typescript
isTypeId(value: unknown): boolean     // validates string as TypeId
isEntity(entity: any): boolean        // checks for typeId property
getIdentifierType(id: string): IdentifierType
```

## Type Registry

`SchemaRegistry` (`flow_sdk/fs_store/schema_registry.py`) is the single source of truth for all type metadata. It maps type name strings to `TypeInfo` dataclasses that hold both the record class and the entity class for each type.

Two legacy facades exist for backward compatibility — they delegate all operations to `SchemaRegistry`:

### DB Entity Registry (`flow_sdk/schema/entity_factory.py`)

`type_registry` is an `_EntityRegistryShim` instance. The old `TypeRegistry` / `RegistryEntry` classes have been replaced by this shim.

```python
# Shim API — all calls forward to SchemaRegistry
type_registry.get(name)             # → SchemaRegistry.get_entity_cls(name)
type_registry.is_registered(name)   # → SchemaRegistry.is_entity_type(name)
type_registry.is_implemented(name)  # → SchemaRegistry.is_implemented(name)
type_registry.get_public_types()    # → SchemaRegistry.get_public_entity_types()
type_registry.register(...)         # no-op — registration via __init_subclass__
```

DB entities auto-register directly into `SchemaRegistry` via `__init_subclass__` on `DBBaseRecord`:

```python
class DBBaseRecord(BaseModel):
    def __init_subclass__(cls, **kwargs):
        super().__init_subclass__(**kwargs)
        SchemaRegistry.register(TypeInfo(..., entity_cls=cls))  # ← auto on class definition
```

### FS Record Registry (`flow_sdk/fs_store/factory/type_registry.py`)

`type_registry` is an `_FsRegistryShim` instance.

```python
# Shim API — all calls forward to SchemaRegistry
type_registry.get(type_name)        # → SchemaRegistry.get_record_cls(type_name)
type_registry.get_all_types()       # → SchemaRegistry.get_all_record_types()
type_registry.register(...)         # no-op — registration via __init_subclass__
```

FS records auto-register directly into `SchemaRegistry` via `__init_subclass__` on `Record`:

```python
class Record:
    _record_type: ClassVar[str] = ""

    def __init_subclass__(cls, **kwargs):
        rt = cls.__dict__.get("_record_type")
        if rt:
            SchemaRegistry.register(TypeInfo(..., record_cls=cls))  # ← auto on class definition
```

### TypeScript Registry (`ts_sdk/src/resource_management/fs_records/record-type-registry.ts`)

```typescript
class RecordTypeRegistry {
  private _types = new Map<string, FsRecordConstructor>();
  register(recordType: string, ctor: FsRecordConstructor): void
  get(recordType: string): FsRecordConstructor | undefined
  has(recordType: string): boolean
}

export const fsRecordTypeRegistry = new RecordTypeRegistry();
```

## Entity Types

### DB Entity Types (`BuiltinEntityType` enum)

Defined in `flow_sdk/db/drivers/db_base_record.py`:

```
user, visitor, app_host, team, group, organization, workspace,
account, page, flow, agent, invitation, mention, connection,
extension, func, sync_service, plugin, plugin_manifest,
flowpad_service, storage_device, flow_file, micro_app, web_domain,
compute_node, job, system_job, job_execution, project, artifact,
api_key, code_ref, comment, agent_hook, trigger,
agentic_process, process_result, workflow
```

### FS Record Types (`RecordType` enum)

Defined in `flow_sdk/fs_store/record_types.py`. A selection:

```
task, skill, log, rule, agentic_process, artifact, memo,
claude_session, claude_hook, claude_error, claude_debug_log,
claude_settings, claude_settings:oauth_account, claude_usage,
compute_node, hook, hook_entry, todo_file, todo_item, plan,
command, mcp_server, plugin, claude_md, history, ...
```

Note: colon-delimited subtypes (e.g. `claude_settings:oauth_account`) are used for nested record hierarchies.

## Relationship to VFS

TypeId is the entity-addressing prefix in [VFS paths](./vfs.md):

```
vfs://{typeid}/{entity_sub_path}
       ↓
  compute_node-@local/Users/alice/file.md
```

In HTTP routes, the TypeId is split across path segments:

```
/api/v1/graph/{type}/{id}/...
              ↓      ↓
        compute_node  @local
```

## Implementations

| Language   | File                                                                | Purpose                                                 |
| ---------- | ------------------------------------------------------------------- | ------------------------------------------------------- |
| Python     | `flow_sdk/fs_store/type_id.py`                                      | `TypeId` class (canonical)                              |
| Python     | `flow_sdk/api/type_id.py`                                           | Backward-compat re-export of `TypeId`                   |
| Python     | `flow_sdk/fs_store/identifier.py`                                   | `IdentifierType` enum, patterns, validators (canonical) |
| Python     | `flow_sdk/api/identifier.py`                                        | Backward-compat re-export of identifier module          |
| Python     | `flow_sdk/api/validation.py`                                        | `UUID_PATTERN` constant                                 |
| Python     | `flow_sdk/fs_store/schema_registry.py`                              | `SchemaRegistry` — unified type registry (canonical)    |
| Python     | `flow_sdk/schema/entity_factory.py`                                 | DB entity registry shim (delegates to SchemaRegistry)   |
| Python     | `flow_sdk/fs_store/factory/type_registry.py`                        | FS record registry shim (delegates to SchemaRegistry)   |
| Python     | `flow_sdk/fs_store/record_types.py`                                 | `RecordType` enum                                       |
| Python     | `flow_sdk/db/drivers/db_base_record.py`                             | `BuiltinEntityType` enum, auto-registration             |
| Python     | `flow_sdk/fs_store/record.py`                                       | FS Record auto-registration                             |
| TypeScript | `ts_sdk/src/models/TypeId.ts`                                       | `TypeId` class, `IdentifierType` enum, validators       |
| TypeScript | `ts_sdk/src/resource_management/fs_records/record-type-registry.ts` | FS record type registry                                 |
| TypeScript | `ts_sdk/src/resource_management/fs_records/record-types.ts`         | `RecordType` enum                                       |
| Tests      | `tests/unit/test_typeid.py`                                         | Python TypeId tests                                     |
