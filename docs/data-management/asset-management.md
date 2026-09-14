---
id: 35f0f36b-d292-4010-a201-1fffcc33952e
---

# Asset management

`flow_sdk.assets` owns filesystem asset discovery, identity resolution, installation,
removal, projection, usage matching, and inventory assembly. `Asset` and
`AssetFolder` are frozen `DataSpec` values. It does not query an Entity, database, or index, initialize
application state, or select a user/project scope. Application adapters supply
paths and configuration and persist their own state after calling these utilities.

## Filesystem handles

```python
from pathlib import Path
from flow_sdk.assets import Asset, AssetFolder
from flow_sdk.assets.materialize import MaterializationMode

asset = Asset.from_path(Path("/project/.claude/skills/review"))
asset = Asset.from_typeid(typeid, records_root=Path("/instance/records"))
installed = asset.install(Path("/destination/.claude/skills/review"))
linked = asset.install(Path("/other/.claude/skills/review"), mode=MaterializationMode.LINK)
assets = AssetFolder(path=Path("/project/.claude"), project_id=project_id).assets()
containing_asset = Asset.containing(Path("/project/.claude/skills/review/references/guide.md"))
```

These are synchronous filesystem methods. Async application callers can offload
blocking work. `Asset.path` selects one actual occurrence; `typeid` is computed
from the registered layout and its identity carrier and cannot be supplied
independently. `project_id` is optional occurrence context provided by a caller,
not an ownership lookup. `from_typeid` requires an explicit records root, reads
its FSRecord metadata, obtains
`asset_path`, and calls `from_path`; a missing record/path or mismatched identity
is an error. There is no fallback to the index or a global name search.
Serialized values include the computed TypeId. Loading one re-reads the file
and checks that identity; the serialized ID cannot override a changed file.

Reads never stamp identities. Valid v4/v5 carrier IDs are adopted through TypeInfo;
missing or foreign carriers use its existing read-only keyed/path fallback.
Malformed carriers are errors. The occurrence entry path retains a final symlink;
`resolved_path` names the target separately. Distinct copies or links may share a
TypeId. Enumeration deduplicates overlapping scans by occurrence path, not TypeId.

`AssetFolder` accepts a scope folder, provider container such as `.claude`, or
family folder. It uses registered mounts/layouts; recursive traversal is explicit
or declared by the type. Missing optional roots are empty. `scan()` returns an
`AssetScanResult` containing valid occurrences and path-specific issues;
`assets()` raises `AssetScanError` when any issue exists. `collect_asset_scan`
combines folders, retaining the best supplied project context and one occurrence
per path. UI catalogs use this tolerant result so a malformed candidate does not
hide unrelated assets. `destination_for(asset)` uses
the supplied folder's layout. A scope root with several possible harness
placements requires the caller to choose a provider/family folder.

The existing TypeInfo registry loads pure declarations first. Application startup
binds Entity classes and runtime observers separately; a failed declaration import
fails initialization instead of silently hiding a type. Pure document decoding
returns FSRecord data without constructing an Entity. A nested filesystem spec
uses `SubAsset[Spec]`; an ordinary inline spec remains ordinary structured data.

## Installation and application adapters

`asset.install(path, mode=COPY, overwrite=False)` takes the **exact destination**.
It stages and validates files before replacement, preserves identity, rejects
source/destination overlap, and rolls back a failed replacement. Copies can stamp
the adopted identity into the destination; the source stays unchanged. A layout
that cannot preserve the source type/identity is rejected. Linking is explicit.
The result is a new `Asset` with no inherited source-project context.

`asset.remove()` removes that occurrence. Removing a symlink never removes its
target. Process attachments additionally use ownership receipts so detach cannot
remove an unrelated replacement. Broken links can be detached from their receipt.

User/project selection, Project lookup, hub publication, indexing, setup, and
dependency recording belong to application adapters. The published installer
selects a destination, invokes the same filesystem installation, and then records
provenance and performs its application work. Publication/VFS Entity adapters are
outside the asset package. Bundle transfer utilities preserve root-only exclusions,
byte-identical re-receive, conflict reporting, and tracked-file-only uninstall.

## Process inventory and observed usage

`process.get_asset_folders()` supplies configured filesystem roots;
`get_embedded_assets()` resolves installed occurrences;
`get_used_assets()` delegates normalized transcript evidence to the SDK matcher.
Inline personas remain process configuration. Merely attaching an asset does not
establish that a worker used it.

Usage records retain the optional resolved Asset, original reference, resolution
status, and ordered evidence. Explicit file paths and correlated provider results
identify occurrences. A name-only invocation requires an unambiguous historical
binding; current native discovery is not historical evidence. Missing, unbound,
and ambiguous asset references remain visible. Ordinary non-asset file reads do
not become missing-asset rows.

The existing `get-assets` action assembles filesystem presence, attachment,
worker availability, and usage on the backend. It returns `assets`, `used_assets`,
`unresolved_usage`, resolved assistant enablement, and optional availability errors.
The UI renders those results. Native verification failure retains readable
catalog entries and historical usage, without marking availability as verified.
Live PTY inspection uses saved launch
configuration, not pending edits; fresh inspection does not certify what a running
worker cached before later file changes.

## Editor and UI adapters

Markdown editors read the exact occurrence through the existing FS action:
`GET .../fs/document/<path>`. The response includes `body_ref`, raw text, typed
metadata, body, body start line, optional metadata error, and a content revision.
`POST` to the same operation requires `expected_revision` and accepts optional
`body`, `set_fields`, and `drop_fields`. The backend owns YAML parsing and
preservation, writes once, and refreshes the application projection. Skill eval and Agent profile controls
use this same typed patch; it does not issue a second Entity save or client
reindex request. Read-only previews may split text for display but never use
that flat metadata representation to write a document.

Resolving an editor path is read-only: `assets/resolve` reads the filesystem
occurrence without stamping its identity or running an index reconciliation.
If optional Entity projection fails, Markdown-backed editors retain the exact
body address and show the projection warning; malformed metadata does not hide
the readable document or cause a write during navigation.

Missing legacy Whiteboard documents are repaired through
`POST .../fs/ensure_document/<path>` with an explicit TypeId and scaffold fields.
The authorized selected occurrence must match the type's declared main document.
The library adds missing defaults and verifies identity; existing canvas data,
prose, and another copy with the same TypeId are preserved.

A stale revision returns `409 stale_document` without changing bytes. Editors
retain dirty and in-flight drafts, pause autosave after failure, and let the user
inspect current disk text or explicitly discard edits and reload. Background
entity refreshes do not replace dirty drafts. A successful save adopts the new
revision while preserving edits made during the request.

Quick Create sends an exact destination `FSRefJson` on the existing entity create
request. User, project, and custom-folder choices select folders; the backend
validates authority and destination. Available mount choices come from the type
registry's `scan_mounts`, with no frontend harness-to-directory map. Discover
reads the backend-projected `body_ref`, so copies sharing a TypeId retain their
selected occurrence. Staging uses the backend's `attachable` flag. Inventory
responses retain valid `assets` alongside `scan_issues` and `truncated`; the UI
shows diagnostics without dropping readable entries.

Journey expansion projects `project_root` only when the actual occurrence is
contained in its owning project's resolved folder. The client demand-loads that
projection before reading steps. An explicitly absent root does not fall back
to an unrelated active project for project-relative actions or terminal creation.
