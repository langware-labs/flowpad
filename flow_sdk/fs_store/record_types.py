"""Record type constants used across the fs_store layer.

Backward-compatibility shim: `RecordType` (and `SkillitRecordType`) are now
aliases of the single canonical `EntityType` in `flow_sdk/schema/types.py`.
Import `EntityType` directly in new code.
"""

from flow_sdk.schema.types import EntityType

# Aliases — same class, kept so existing imports keep working during migration.
RecordType = EntityType
SkillitRecordType = EntityType
