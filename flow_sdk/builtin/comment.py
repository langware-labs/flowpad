import logging
from typing import Any, ClassVar, Dict, Optional

from pydantic import field_validator

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType


class Comment(Entity):
    type: str = APIField(default=BuiltinEntityType.COMMENT.value)
    raw_content: Optional[str] = APIField(default=None, blob=True)
    # Anchor metadata. Markdown comments use {"line": N} (1-based source line).
    # Mirrors Annotation.data — opaque dict keeps the field reusable for future
    # anchor kinds (ranges, char offsets) without a migration.
    # A doc comment's data is a ``doc.comment`` value (kind, status, anchor, body) or a
    # ``doc.comment_reply`` — see ``doc_comment_spec``; checked on every construct.
    data: Optional[Dict[str, Any]] = APIField(default_factory=dict)

    @field_validator("data")
    @classmethod
    def _doc_comment_fits(cls, value: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        from flow_sdk.schema.data_spec.doc_comment_spec import check_comment_data

        if value:
            check_comment_data(value)
        return value
