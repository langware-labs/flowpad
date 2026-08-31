"""Type metadata for MICRO_APP — a webapp, which is an asset like any other.

A REPO folder asset, so the existing ``repo_assets_fn`` walker finds one with no
new discovery code — including one nested INSIDE another asset's
``agentic-assets/``, which is how an asset ships the app that edits it: the
walker recurses, and the enclosure rule makes the containing asset its parent.

``family="webapp"`` rather than the type name, for the reason
``data_source_spec_type_info`` gives for ``family="data_source"``: the folder a
human reads should be named for the thing, not for the internal distinction
between the delivery row and the app.

Not every MicroApp is an asset. ``flow app serve`` registers a row for a folder
somewhere in the user's checkout, which has no ``webapp.json`` and no
``asset_ref``; such a row is DB-only and the orphan sweep never considers it.
"""
from flow_sdk.builtin.faas.webapp_spec import WebappManifestSpec
from flow_sdk.fs_store.indexer.functions._asset_identity import derived_identity
from flow_sdk.fs_store.indexer.functions.webapp import derive_webapp
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType

# MicroApp is an Entity but had no TypeMetadata, so the registry could not see
# it: no icon, no display name, absent from the bootstrap schema the frontend
# queries through. Registering it is what lets an app's delivery row be read
# from the UI at all — the same treatment its sibling companion Deployment and
# its subject Artifact already have.
MICRO_APP = TypeMetadata(
    type=EntityType.MICRO_APP,
    api_visible=True,
    icon="AppWindow",
    displayName="Apps",
    # Authored in a folder next to the thing it serves, not from a New button.
    creatable=False,
    indexed_by_default=True,
    asset_class="repo",
    family="webapp",
    main_layout="folder",
    main_file="webapp.json",
    asset_spec=WebappManifestSpec,
    derive_fields_fn=derive_webapp,
    fts_content=("name", "title", "description"),
    index_fields=["name", "kind", "artifact_id"],
    # DERIVED, not a capsule: `webapp.json` deliberately carries no id, so the
    # id falls out of the path — a shipped editor then has the SAME id on every
    # machine, which is what makes a `/dock/app/micro_app-<uuid>` link portable.
    # A capsule would also make a shared app arrive carrying the sender's id.
    identity_carrier=derived_identity(),
)
