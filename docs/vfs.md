---
id: "e1a0f701-7f37-52c4-8fcb-9bcdb7d14077"
---

# VFS Path Specification

VFS (Virtual File System) paths provide a universal URI scheme for addressing files stored under any entity in the system. Every entity that supports file storage (compute nodes, agents, projects, workspaces, users) exposes its files through this single path format.

## Format

```
vfs://{type}-{id}/{entity_sub_path}
```

| Component           | Required | Description                                                             |
| ------------------- | -------- | ----------------------------------------------------------------------- |
| `vfs://`            | No       | Protocol prefix. May be omitted — paths are valid without it.           |
| `{type}`            | Yes      | Entity type: `compute_node`, `agent`, `project`, `workspace`, `user`    |
| `{id}`              | Yes      | Entity identifier (see [ID Formats](#id-formats) below)                 |
| `{entity_sub_path}` | No       | Path within the entity's storage. No leading `/`, forward slashes only. |

The `{type}-{id}` portion is a standard [TypeId](../flow_sdk/api/type_id.py).

## ID Formats

The `{id}` segment supports four identifier formats:

| Format    | Pattern                                | Example                                             |
| --------- | -------------------------------------- | --------------------------------------------------- |
| UUID      | `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` | `compute_node-550e8400-e29b-41d4-a716-446655440000` |
| Named     | `@{name}`                              | `agent-@local`                                      |
| Namespace | `{PREFIX}-{value}`                     | `workspace-WORKSPACE-123`                           |
| Prop ID   | `{key}.{value}`                        | `user-email.john_doe`                               |

In desktop/local mode the named id `@local` is used for all bootstrap entities.

## Parsing Examples

```
vfs://compute_node-@local/Users/alice/file.md
  type:           "compute_node"
  id:             "@local"
  entitySubPath:  "Users/alice/file.md"

agent-@local/skills/test.md          (no protocol prefix)
  type:           "agent"
  id:             "@local"
  entitySubPath:  "skills/test.md"

compute_node-@local/                  (entity root, no sub-path)
  type:           "compute_node"
  id:             "@local"
  entitySubPath:  ""

/Users/alice/file.md                  (bare absolute path, no TypeId)
  type:           null
  id:             null
  entitySubPath:  "Users/alice/file.md"
```

### Bare absolute path fallback (Python only)

When the Python backend receives a bare absolute path (starts with `/`, no TypeId prefix), it auto-resolves the owning entity:

1. If a request context exists, uses the authenticated user's TypeId.
2. In desktop mode, defaults to `compute_node-@local`.
3. Otherwise raises `ValueError`.

The TypeScript `VFSPath` does **not** auto-resolve — it sets `type` and `id` to `null`.

## Path Normalization

All paths stored internally use forward slashes with no leading slash:

| OS Input                             | Normalized `entitySubPath` |
| ------------------------------------ | -------------------------- |
| `/Users/alice/file.md` (macOS/Linux) | `Users/alice/file.md`      |
| `C:\Users\alice\file.md` (Windows)   | `Users/alice/file.md`      |

Windows drive letters (`C:\`, `D:\`) are stripped. Backslashes are converted to forward slashes.

## HTTP API Mapping

All filesystem operations go through the graph catch-all route. The URL encodes the entity TypeId, the `fs` action keyword, the specific operation, and the file path:

```
{method} /api/v1/graph/{type}/{id}/fs/{fs_action}/{entity_sub_path}
```

### Examples

```
GET    /api/v1/graph/compute_node/@local/fs/browse/Users/alice
GET    /api/v1/graph/compute_node/@local/fs/download/Users/alice/file.md
POST   /api/v1/graph/compute_node/@local/fs/upload/Users/alice
POST   /api/v1/graph/compute_node/@local/fs/write/Users/alice/file.md
POST   /api/v1/graph/compute_node/@local/fs/mkdir/Users/alice/new-dir
DELETE /api/v1/graph/compute_node/@local/fs/delete/Users/alice/file.md
GET    /api/v1/graph/compute_node/@local/fs/download_zip/Users/alice/folder
POST   /api/v1/graph/compute_node/@local/fs/upload_zip/Users/alice/folder
```

### Request flow

```
HTTP Request
  → RequestTransactionMiddleware (parse URL into RequestInfo, auto-auth)
  → Graph catch-all route (/api/v1/graph/{path})
  → "fs" action handler
  → EntityFSReqInfo.from_request_info() extracts fs_action + VFSPath
  → Dispatches to specific handler (browse, download, upload, ...)
```

## Supported FS Actions

| Action            | Method | Description                          |
| ----------------- | ------ | ------------------------------------ |
| `browse`          | GET    | List directory contents → `FSItem[]` |
| `download`        | GET    | Stream file content                  |
| `download_zip`    | GET    | Download directory as ZIP archive    |
| `upload`          | POST   | Upload files (multipart form)        |
| `upload_zip`      | POST   | Upload and extract ZIP archive       |
| `write`           | POST   | Write content to a file              |
| `mkdir`           | POST   | Create a directory                   |
| `delete`          | DELETE | Delete a file or directory           |
| `rename`          | POST   | Rename a file or directory           |
| `copy`            | POST   | Copy a file or directory             |
| `move`            | POST   | Move a file or directory             |
| `open`            | GET    | Open file with system default app    |
| `create_symlink`  | POST   | Create a symbolic link               |
| `resolve_symlink` | GET    | Resolve a symbolic link target       |
| `import_item`     | POST   | Import an item into entity storage   |

## Implementations

| Language   | File                           | Class                        |
| ---------- | ------------------------------ | ---------------------------- |
| Python     | `flow_sdk/api/fs/fs_api.py`    | `VFSPath`, `EntityFSReqInfo` |
| TypeScript | `ts_sdk/src/utils/vfs-path.ts` | `VFSPath`                    |

Supporting files:

* FS action dispatcher: `flow_sdk/actions/fs/main_fs_action.py`

* FS action handlers: `flow_sdk/actions/fs/fs_actions.py`

* Storage driver: `flow_sdk/storage/local_fs_driver.py`

* FS item entity: `flow_sdk/builtin/fs_entities.py`

* TS FS service: `ts_sdk/src/services/fsService.ts`

* TS FS store: `ts_sdk/src/stores/fsStore.ts`

* Unit tests: `ui/tests/unit/vfs-path.test.ts`, `tests/api/test_unit_fs.py`

