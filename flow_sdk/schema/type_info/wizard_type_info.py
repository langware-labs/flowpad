"""Type metadata for WIZARD — folder-backed AUTONOMOUS setup document.

The counterpart of JOURNEY, and the distinction is why both exist:

    A Journey PRESENTS a step and waits for a person.
    A Wizard DECIDES and executes.

A journey step carries ``present`` / ``waitFor`` and parks the run until a
person acts; a wizard step carries a per-OS command whose exit code decides
whether to skip or to act, and runs unattended. Keep that line — a Wizard that
grows a ``waitFor`` vocabulary has become a second Journey.

A flowpad-native REPO asset at ``agentic-assets/wizard/<name>/wizard.json``,
found by the shared ``repo_assets_fn`` walker via ``main`` — no bespoke walker
and no edit to the indexer's registration graph.

``identity_carrier`` is the SIDECAR, not the document: it keeps the id out of
``wizard.json`` so a wizard shipped in the wheel carries none, and each install
stamps its own uuid4 capsule instead of every install sharing one id.
"""
from flow_sdk.fs_store.indexer.functions._asset_identity import folder_json_identity
from flow_sdk.fs_store.indexer.functions.wizard import extract_wizard, wizard_asset_hash
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.layout import Folder
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode

WIZARD = TypeInfo(
    type_name=EntityType.WIZARD,
    # Not Compass — that is Journey's. A wand is the "it does it for you" glyph.
    icon="Wand2",
    display_name="Wizards",
    browseable_by=ViewMode.STANDARD,
    creatable=True,
    indexed_by_default=True,
    api_visible=True,
    cloud_file_transport="git",
    index_fields=["description"],
    asset_class="repo",
    family="wizard",
    shape=Folder(main="wizard.json"),
    name_from_path=True,
    editor="wizard",
    from_disk_fn=extract_wizard,
    identity_carrier=folder_json_identity(),
    asset_hash_fn=wizard_asset_hash,
)
