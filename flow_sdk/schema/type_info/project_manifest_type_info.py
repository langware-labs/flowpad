"""Type metadata for PROJECT_MANIFEST — the per-project ledger of published assets.

A flowpad-native REPO folder asset, and a **singleton**: the entity-type
directory ``agentic-assets/project_manifest/`` IS the asset (no ``<name>``
segment), one per project, found by the shared ``repo_assets_fn`` walker via
``main_file`` like any other repo asset.

The file is the truth about what is published; ``Entity.published`` on the
referenced rows is a cache that ``reconcile_published_cache`` refreshes after
every index of this asset (``post_sync_fn``). Nothing here is derived from a
path: the manifest's own id is a v4 minted once into its sidecar capsule and
travels with git.

Never browseable and never creatable from the UI — it is written only by an
asset's ``set-published`` action.
"""
from flow_sdk.fs_store.indexer.functions._asset_identity import folder_json_identity
from flow_sdk.fs_store.operations.project_manifest import reconcile_published_cache
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.data_spec.project_manifest_spec import PROJECT_MANIFEST_MAIN, ProjectManifestSpec
from flow_sdk.schema.layout import Folder
from flow_sdk.schema.types import EntityType

PROJECT_MANIFEST = TypeInfo(
    type_name=EntityType.PROJECT_MANIFEST,
    icon="PackageCheck",
    display_name="Project manifest",
    browseable_by=None,
    creatable=False,
    indexed_by_default=True,
    api_visible=True,
    # Git-publishable like a document: the manifest rides to the hub through
    # the same publish_asset path a shared doc does, so the hub can serve it.
    asset_class="repo",
    family="project_manifest",
    singleton=True,
    shape=Folder(main=PROJECT_MANIFEST_MAIN),
    name_from_path=True,
    asset_spec=ProjectManifestSpec,
    identity_carrier=folder_json_identity(),
    post_sync_fn=reconcile_published_cache,
)
