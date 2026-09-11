---
id: 35f0f36b-d292-4010-a201-1fffcc33952e
---

# Asset management

`flow_sdk.assets` owns filesystem asset discovery, identity resolution, installation,
removal, projection, usage matching, and inventory assembly. Its values are frozen
`DataSpec` subclasses. It does not query an Entity, database, or index, initialize
application state, or select a user/project scope. Application adapters supply
paths and configuration and persist their own state after calling these utilities.

## Filesystem handles

```python
from pathlib import Path
from flow_sdk.assets import Asset, AssetFolder
from flow_sdk.assets.materialize import MaterializationMode

asset = Asset.from_path(Path("/project/.claude/skills/review"))
asset = Asset.from_typeid(typeid)
installed = asset.install(Path("/destination/.claude/skills/review"))
linked = asset.install(Path("/other/.claude/skills/review"), mode=MaterializationMode.LINK)
assets = AssetFolder(path=Path("/project/.claude"), project_id=project_id).assets()
containing_asset = Asset.containing(Path("/project/.claude/skills/review/references/guide.md"))
```

These are synchronous filesystem methods. Async application callers can offload
blocking work. `Asset.path` selects one actual occurrence; `typeid` is computed
from the registered layout and its identity carrier and cannot be supplied
independently. `project_id` is optional occurrence context provided by a caller,
not an ownership lookup. `from_typeid` reads `FSRecord.load(type, id)`, obtains
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
or declared by the type. Missing optional roots are empty; malformed candidates
raise `AssetScanError` with path-specific issues. `destination_for(asset)` uses
the supplied folder's layout. A scope root with several possible harness
placements requires the caller to choose a provider/family folder.

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
The UI renders those results. Native verification failure differs from a verified
empty list and never erases historical usage. Live PTY inspection uses saved launch
configuration, not pending edits; fresh inspection does not certify what a running
worker cached before later file changes.
