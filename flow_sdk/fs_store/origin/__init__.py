"""Where bytes live — the origin models and their discriminated union.

Lives under ``fs_store`` (not ``builtin``) so ``entity_model`` can type its
``origin`` field at class-build time: importing ``flow_sdk.builtin.*`` runs the
builtin package init, which imports ``Entity``.
"""

from flow_sdk.fs_store.origin.cloud_origin import CloudOrigin, CloudOriginLocal
from flow_sdk.fs_store.origin.field import ORIGIN_ADAPTER, OriginField, SoftOrigin, origin_tag
from flow_sdk.fs_store.origin.fs_origin import (
    DEFAULT_ORIGIN_KIND,
    ORIGIN_KIND_ALIASES,
    FSOrigin,
    is_safe_rel_path,
    resolve_origin_kind,
)
from flow_sdk.fs_store.origin.git_origin import GitOrigin, PortableGitOrigin, as_git
from flow_sdk.fs_store.origin.local_origin import LocalOrigin, local_origin_for_path, local_origin_key

__all__ = [
    "CloudOrigin", "CloudOriginLocal", "DEFAULT_ORIGIN_KIND", "FSOrigin", "GitOrigin", "LocalOrigin",
    "ORIGIN_ADAPTER", "ORIGIN_KIND_ALIASES", "OriginField", "PortableGitOrigin", "SoftOrigin", "as_git",
    "is_safe_rel_path", "local_origin_for_path", "local_origin_key", "origin_tag", "resolve_origin_kind",
]
