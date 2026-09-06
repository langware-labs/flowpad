from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.types import EntityType

# DB-only handle for files outside the record store (SemanticLock targets).
# Not walked, not browseable — rows are minted on demand (ensure_file_entity).
FILE = TypeInfo(type_name=EntityType.FILE, icon="File", api_visible=True)
