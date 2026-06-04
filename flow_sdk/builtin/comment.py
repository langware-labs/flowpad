import logging
from typing import Any, ClassVar, Dict, Optional

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType


class Comment(Entity):
    type: str = APIField(default=BuiltinEntityType.COMMENT.value)
    raw_content: Optional[str] = APIField(default=None, blob=True)
    # Anchor metadata. Markdown comments use {"line": N} (1-based source line).
    # Mirrors Annotation.data — opaque dict keeps the field reusable for future
    # anchor kinds (ranges, char offsets) without a migration.
    data: Optional[Dict[str, Any]] = APIField(default_factory=dict)
