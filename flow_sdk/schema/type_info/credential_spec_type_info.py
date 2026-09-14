"""Type metadata for CREDENTIAL_SPEC — a named set of environment variables.

A REPO folder asset at ``agentic-assets/credential/<name>/credential.json``, found
by the shared ``repo_assets_fn`` walker in any walked container: a project mount
(project scope), the user's home (user scope) and the shipped assistant project
(system scope — templates).

Identity is a WRITABLE folder capsule: a v4 minted once at creation and kept in
``.flow/capsules/identity.json``. The shipped templates commit theirs, so every
install indexes the same catalogue row instead of one per install path.
"""
from flow_sdk.assets.identity import folder_json_identity
from flow_sdk.assets.layout import Folder
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.data_spec.credential_manifest_spec import CredentialManifestSpec
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode

CREDENTIAL_SPEC = TypeInfo(
    type_name=EntityType.CREDENTIAL_SPEC,
    icon="KeyRound",
    display_name="Credentials",
    api_visible=True,
    creatable=True,
    # The row is authoritative once created in-app: an edit rewrites
    # credential.json from the row.
    owns_main_ref=True,
    indexed_by_default=True,
    browseable_by=ViewMode.ADVANCED,
    asset_class="repo",
    family="credential",
    shape=Folder(main="credential.json"),
    asset_spec=CredentialManifestSpec,
    fts_content=("name", "description"),
    identity_carrier=folder_json_identity(),
    index_fields=["name", "title"],
)
