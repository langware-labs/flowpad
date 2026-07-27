---
id: 44fde5fb-1fb6-4518-920e-cf686807280b
---

# FSRef Rules

## FSRef

1. `FSRef` is a pure path declaration — a manifest. It carries no file content and performs no I/O by itself. It is safe to construct, pass around, and store without side effects.

2. `FSRef` has `vpath: VFSPath` property. This property translates the ref into a location on an entity, typically the compute node. The vpath is simply `this.parent.vpath + "/" + this.name`, where parent is the record or record child that owns this ref. Root refs (directly under the entity) have null parent; their entity typeId is taken according to the VFSPath spec.

3. `FSRef` file operations dispatch via `computeNode.fsAction(ref.vpath, operation, ...)` to the backend. From the backend perspective the ref actions are standard fs actions.

4. Python `FSRef`: dispatches to direct I/O via the compute node's storage provider. No HTTP. TypeScript `FSRef`: dispatches via HTTP to `api/v1/graph/compute_node/{id}/fs/{action}/{entity_sub_path}`. Same interface, different transport.

5. All FSRef I/O actions work with FSRefs. `FSRef.ls()` returns a list of FSRefs for all items currently on disk under this path. `FSRef.read()` returns the file content. `FSRef.write(content)` writes to the file. `FSRef.delete()` removes the file or directory.

6. `FSRef.ls()` (filesystem listing) and `FSRef.children()` (declarative children) are distinct and unrelated. `ls()` hits the filesystem and returns whatever is present. `children()` returns the statically declared named child refs defined on the Record/FsRecord class — it never touches the filesystem and its result is independent of disk state.

7. Named child refs are declared as computed properties on the Record/FsRecord class — never constructed inline in business logic. Example: `skill_md_ref = asset_ref.child("SKILL.md")`. `child(name)` returns a new FSRef with the same typeId and `entity_sub_path + "/" + name`.

8. `FSItem` is the generic file browsing interface and hooks in the UI. FSRef does not use FSItems — it works directly with the compute node fs API.

## VFSPath

1. **VFSPath format**: `"{entity_type}-{entity_id}/{entity_sub_path}"` — encodes both who owns the file (the ComputeNode TypeId) and where it is (path relative to the compute node's mount root). Example: `compute_node-@local/Users/alice/.claude/skills/my-skill/SKILL.md`. With protocol: `"vfs://{abs_vfspath}"`. `entity_sub_path` never has a leading slash.

2. The typeId segment uses `{type}-{id}` where `id` is a UUID or `@name` (e.g. `@local`). The separator between typeId and `entity_sub_path` is always a single `/`.

3. VFSPath is always constructed via static factories — never raw string concatenation. Python: `VFSPath(str)` or `VFSPath.from_entity_path(typeid, path)`. TypeScript: `VFSPath.parse(str)`, `VFSPath.fromTypeId(typeId, path)`, `VFSPath.fromMachinePath(absPath, typeId)`.

4. `VFSPath.fromMachinePath(absPath, typeId)` strips the leading slash (mac/linux) or drive prefix (windows) and combines with the typeId. Use this when converting OS absolute paths to VFSPaths.

5. A VFSPath is **absolute** if it has a typeId prefix; **relative** if it has only an `entity_sub_path`. Relative VFSPaths cannot be used for I/O.

6. `absVfsPath` / `abs_vfspath` — path without `vfs://` protocol. `uri` — path with `vfs://` protocol. All I/O uses `absVfsPath`; `uri` is for display and JSON storage.

7. `entitySubPath` / `entity_sub_path` — the portion after the typeId and slash. Always no leading slash. Empty string means the entity root. `filename` — last segment of `entitySubPath`. `parent` — new VFSPath with last segment stripped, same typeId.

8. The backend always constructs a VFSPath from the URL via `EntityFSReqInfo.from_request_info()`: entity typeId from the URL path, `fs_action` from the first sub_path segment, `entity_sub_path` from the remaining segments. All fs handler code operates on `fs_info.vpath`, never on raw path strings.

9. Python fallback: a VFSPath string starting with `/` and no typeId defaults to `compute_node-@local` in desktop mode (via `is_desktop()` or request context).

## FSRef JSON Serialization

1. `FSRef.to_dict(type_id="")` returns `{path, ref_type, read_only, type_id}`. `ref_type` is one of `"text" | "json" | "folder" | "file"`. `type_id` is the entity's TypeId string (e.g. `"compute_node-@local"`) injected by the caller.
   - `JSONFsRef._ref_type()` → `"json"`; `TextFsRef._ref_type()` → `"text"`; base `FSRef._ref_type()` → `"folder"` if `is_dir`, else `"file"`.

2. `FSRef.from_dict(d)` reconstructs the right subclass from a serialized dict. `ref_type="json"` → `JSONFsRef`; `ref_type="text"` → `TextFsRef`; otherwise plain `FSRef`.

3. TypeScript: `FSRefJson` interface mirrors the Python dict: `{path, ref_type, read_only, type_id}`. `FSRef.fromJson(json)` constructs an FSRef from the backend payload. `FSRef.toJSON()` returns `FSRefJson`.

## Record Refs Endpoint

1. `GET /api/v1/graph/{type}/{id}/record/refs` returns `{self_ref: FSRefJson | null, main_ref: FSRefJson | null}`.
   - `self_ref` points to the record folder (type `"folder"`).
   - `main_ref` points to the primary content ref; default is `data/_data.json` (type `"json"`); subclasses override (e.g. `SkillRecord.main_ref` → `SKILL.md` with type `"text"`).

2. TypeScript: `entity.record()` calls the endpoint and returns a `Record` instance (`ts_sdk/src/fs/Record.ts`) with `selfRef: FSRef | null` and `mainRef: FSRef | null`.
   - Use `ref.child(name)` chaining to navigate: `entity.record().then(r => r.mainRef?.child("resources").child("file.txt"))`.

3. Both `selfRef` and `mainRef` carry the entity's `type_id` so `FSRef.fromJson()` can reconstruct the correct typeId for HTTP dispatch.
