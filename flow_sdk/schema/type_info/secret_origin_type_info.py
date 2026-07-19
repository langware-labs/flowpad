"""Type metadata for SECRET_ORIGIN.

The value-free secret reference is a first-class **file asset** at
``<project>/assets/sodot/<name>.json`` (see ``docs/secret_share.md``): indexed like
any other asset, git-committed, and travels with a shared project. Discovery +
extraction live in ``flow_sdk/fs_store/indexer/functions/secret_origin.py``; the id
minted there is the convergent ``SecretOrigin.key()`` (never path-derived) so a
file-indexed row and a DB-minted row collide on one id across machines.
"""
from typing import Optional

from flow_sdk.fs_store.indexer.functions.secret_origin import (
    extract_secret_origin,
    secret_origin_gen_id,
)
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.type_info.base_meta import BaseMeta
from flow_sdk.schema.types import EntityType


class SecretOriginMeta(BaseMeta):
    env_var: Optional[str] = None
    locator: Optional[dict] = None
    sod_store: Optional[str] = None


SECRET_ORIGIN = TypeMetadata(
    type=EntityType.SECRET_ORIGIN,
    icon="KeyRound",
    api_visible=True,
    # Not minted empty from the generic "new entity" UI — created via the project
    # add-secret-pointer action, which writes the reference json.
    creatable=False,
    indexed_by_default=True,
    index_fields=["name", "env_var"],
    asset_class="internal",
    family="assets/sodot",
    main_layout="file",
    main_ext=".json",
    from_disk_fn=extract_secret_origin,
    gen_uuid_fn=secret_origin_gen_id,
    meta_model=SecretOriginMeta,
)
