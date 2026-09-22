"""Type metadata for MICRO_APP — a webapp, which is an asset like any other.

A REPO folder asset, so the existing ``repo_assets_fn`` walker finds one with no
new discovery code — including one nested INSIDE another asset's
``agentic-assets/``, which is how an asset ships the app that edits it: the
walker recurses, and the enclosure rule makes the containing asset its parent.

``family="webapp"`` rather than the type name, for the reason
``data_driver_type_info`` gives for ``family="data_driver"``: the folder a
human reads should be named for the thing, not for the internal distinction
between the delivery row and the app.

Indexing one places it: ``post_sync_fn`` gives the app a ``static`` endpoint on
its project's local placement, and removing the folder takes that endpoint with
it (``orphan_cascade_fn``).
"""
from flow_sdk.assets.identity import derived_identity
from flow_sdk.assets.types.webapp import derive_webapp
from flow_sdk.fs_store.operations.webapp_placement import place_indexed_webapp, unplace_webapp
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.data_spec.webapp_spec import WebappManifestSpec
from flow_sdk.schema.types import EntityType

MICRO_APP = TypeInfo(
    type_name=EntityType.MICRO_APP,
    api_visible=True,
    icon="AppWindow",
    display_name="Apps",
    # Authored in a folder next to the thing it serves, not from a New button.
    creatable=False,
    indexed_by_default=True,
    asset_class="repo",
    family="webapp",
    asset_spec=WebappManifestSpec,
    derive_fields_fn=derive_webapp,
    fts_content=("name", "title", "description"),
    index_fields=["name", "kind"],
    post_sync_fn=place_indexed_webapp,
    orphan_cascade_fn=unplace_webapp,
    # DERIVED, not a capsule: `webapp.json` deliberately carries no id, so the
    # id falls out of the path — a shipped editor then has the SAME id on every
    # machine, which is what makes a `/dock/app/micro_app-<uuid>` link portable.
    # A capsule would also make a shared app arrive carrying the sender's id.
    identity_carrier=derived_identity(),
)
