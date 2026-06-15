"""Type metadata for SHELL."""
from typing import Optional

from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.type_info.base_meta import BaseMeta
from flow_sdk.schema.types import EntityType


class ShellMeta(BaseMeta):
    """FS↔DB metadata schema for shell records.

    The persisted domain fields a shell tab carries on disk. ``tab_order`` is
    deliberately absent — it is DB-only (``persist=FALSE`` on the entity),
    recomputed rather than mirrored. Runtime/worker state (worker_pid,
    error_message, last_launch_cmd) is likewise not persisted.
    """
    status: Optional[str] = None
    workdir: Optional[str] = None
    pty_pid: Optional[str] = None
    compute_node_uname: Optional[str] = None
    created_at: Optional[str] = None
    # Epoch-ms (base-Entity field); old metadata.json rows hold ISO strings.
    last_active_at: Optional[int | str] = None
    auto_rename: Optional[bool] = None


SHELL = TypeMetadata(
    type=EntityType.SHELL,
    icon="Terminal",
    api_visible=True,
    meta_model=ShellMeta,
)
