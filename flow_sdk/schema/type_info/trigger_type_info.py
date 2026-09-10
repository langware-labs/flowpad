"""Type metadata for TRIGGER — what makes something run, and what it then does.

A trigger is now a REPO ASSET: a folder holding ``trigger.json``, discovered by
the generic ``repo_assets_fn`` walk. That means it is found both standalone at
``<scope>/agentic-assets/trigger/<name>/`` and nested inside another asset's own
``agentic-assets/`` — which is how a wizard carries the trigger that launches
it, with ``parent_type_id`` stamped by the indexer for free.

It stays a ROW as well, and both halves are load-bearing. The DOCUMENT is the
declaration and travels over git. The ROW holds what only this machine knows:
``counter`` and ``last_run``, marked ``Persist.TRUE`` so they ride the shadow
record under flow home — never the asset folder, never git. That split is what
makes ``fire_once`` mean anything: a counter committed to a document would land
on a fresh machine already spent, and suppress the first run it was meant to
allow.

``owns_main_ref`` is deliberately FALSE. A save writes ``trigger.json`` only
when it is absent, so a hand-authored or shipped document is never re-rendered
out from under its author.
"""
from flow_sdk.fs_store.indexer.functions._asset_identity import folder_json_identity
from flow_sdk.builtin.trigger_arming import arm_after_index
from flow_sdk.fs_store.indexer.functions.trigger import extract_trigger, trigger_asset_hash
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.layout import Folder
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode

TRIGGER = TypeInfo(
    type_name=EntityType.TRIGGER,
    icon="Zap",
    display_name="Triggers",
    browseable_by=ViewMode.ADVANCED,
    creatable=True,
    indexed_by_default=True,
    api_visible=True,
    cloud_file_transport="git",
    index_fields=["description"],
    asset_class="repo",
    family="trigger",
    shape=Folder(main="trigger.json"),
    name_from_path=True,
    from_disk_fn=extract_trigger,
    # A per-install uuid4 capsule, NOT an id in the document: a trigger shipped
    # in the wheel or cloned from a repo must not hand every install one id.
    identity_carrier=folder_json_identity(),
    asset_hash_fn=trigger_asset_hash,
    # A trigger arms the moment it is INDEXED, not at the next restart. This is
    # what makes "trigger changes take effect after a restart" stop being true.
    post_sync_fn=arm_after_index,
)
