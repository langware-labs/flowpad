"""Type metadata for TODO_FILE."""
import uuid

from flow_sdk.fs_store.indexer.functions._asset_identity import derived_identity
from flow_sdk.fs_store.indexer.functions.todo import (
    extract_todo,
    todo_identity_key,
)
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.layout import File, Walk
from flow_sdk.schema.types import EntityType

TODO_FILE = TypeInfo(
    type_name=EntityType.TODO_FILE,
    icon="ListChecks",
    indexed_by_default=True,
    api_visible=True,
    from_disk_fn=extract_todo,
    # ``~/.claude/todos/*.json`` — Claude Code's per-session todo files; no placement (read-only ingest).
    walk=Walk(roots=("user_home_folder",), mounts=(".claude/todos",)),
    shape=File(ext=".json"),
    identity_carrier=derived_identity(),
    id_stable_key_fn=todo_identity_key,
    id_namespace=uuid.NAMESPACE_DNS,
)
