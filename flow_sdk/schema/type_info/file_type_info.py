from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType

# DB-only handle for files outside the record store (SemanticLock targets).
# Not walked, not browseable — rows are minted on demand (ensure_file_entity).
FILE = TypeMetadata(type=EntityType.FILE, icon="File", api_visible=True)
