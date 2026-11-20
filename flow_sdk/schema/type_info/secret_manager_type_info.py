"""Type metadata for SECRET_MANAGER — a driver over a tool that holds secret vaults.

A REPO folder asset, ``agentic-assets/secret_manager/<name>/``: ``secret_manager.json`` (the
``SecretManagerSpec``), ``store.py`` and ``instructions.md``. The row is the index; the code
is loaded by ``flow_sdk/secrets/managers.py`` from the SHIPPED folder only — a manager handles
secret values in the backend, so a project never supplies one.

Identity is derived from the manifest's ``name`` (a shipped folder's path is the install's).
"""
from flow_sdk.assets.identity import derived_identity
from flow_sdk.assets.types.named_manifest import name_identity_key
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.data_spec.secret_manager_spec import SecretManagerSpec
from flow_sdk.schema.types import EntityType

SECRET_MANAGER = TypeInfo(
    type_name=EntityType.SECRET_MANAGER,
    icon="KeyRound",
    display_name="Secret managers",
    api_visible=True,
    creatable=False,
    asset_class="repo",
    family="secret_manager",
    asset_spec=SecretManagerSpec,
    fts_content=("name", "description"),
    identity_carrier=derived_identity(),
    identity_key_fn=name_identity_key(SecretManagerSpec.main_file),
    index_fields=["name", "title"],
)
