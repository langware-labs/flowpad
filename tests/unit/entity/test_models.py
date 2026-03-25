"""Test models for entity tests."""

from typing import Annotated, Optional

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.db.drivers.db_base_record import FullTextSearch
from flow_sdk.db.relationship_model import Relationship
from flow_sdk.responses.response import ApiSuccessResponse


class TEntity(Entity):
    """Test entity for unit tests."""

    type: str = APIField(default="tentity_ent")
    test_data: str | None = APIField(None)
    test_fulltext: Annotated[Optional[str], FullTextSearch] = APIField(None)
    none_api_field: str | None = "this is sodded"
    blob_field: str | None = APIField(None, blob=True)


class TRelationship(Relationship):
    """Test relationship for unit tests."""

    type: str = APIField(default="trelationship_ent")
