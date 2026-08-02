"""Type metadata for HELPDESK — folder-backed support-desk portal."""

from flow_sdk.fs_store.identity_backend import DerivedIdentityBackend
from flow_sdk.fs_store.indexer.functions.helpdesk import (
    extract_helpdesk,
    helpdesk_asset_hash,
    helpdesk_stable_key,
)
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode

HELPDESK = TypeMetadata(
    type=EntityType.HELPDESK,
    icon="LifeBuoy",
    displayName="Help desks",
    browseable_by=ViewMode.ADVANCED,
    # Authored in a git repo, never through the app's New-asset tiles.
    creatable=False,
    indexed_by_default=True,
    api_visible=True,
    index_fields=["description"],
    # asset_class="repo" is the whole registration: `repo_assets_fn` already
    # walks `<scope>/agentic-assets/<family>/*/` on every root INCLUDING
    # CWD_ROOT, which is how a cloned context folder gets scanned. No edit to
    # the indexer's registration table is needed or wanted.
    asset_class="repo",
    family="helpdesk",
    main_layout="folder",
    main_file="helpdesk.json",
    from_disk_fn=extract_helpdesk,
    # Derived, NOT capsule or native-JSON: both of those write into the
    # checkout. Native-JSON would stamp an `id` into the tracked
    # `helpdesk.json` and the next `git pull` would fail on local changes; the
    # capsule writes `.flow/id` and mints a different v4 per machine. Derived
    # observes nothing and stores nothing, so `mint_id` falls through to the
    # stable key below — read-only and identical on every clone.
    identity_backend=DerivedIdentityBackend(),
    id_stable_key_fn=helpdesk_stable_key,
    asset_hash_fn=helpdesk_asset_hash,
)
