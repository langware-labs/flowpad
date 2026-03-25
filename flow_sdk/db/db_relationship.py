from typing import ClassVar, List, Tuple, TypeVar

from pydantic import ConfigDict

from flow_sdk.db.drivers.db_base_record import DBBaseRelationship
from flow_sdk.db.drivers.db_driver import DBDriver, LazyDBDriver
from flow_sdk.db.drivers.query import QueryFilter

DBRelationshipType = TypeVar("DBRelationshipType", bound="DBRelationship")


class DBRelationship(DBBaseRelationship):
    model_config = ConfigDict(from_attributes=True, arbitrary_types_allowed=True)
    _db: ClassVar[DBDriver] = LazyDBDriver()

    @classmethod
    async def get_by_id(cls, eid: str):
        return await cls._db.get_by_id(eid, cls.get_type())

    @classmethod
    async def get_all_relationships(
        cls: type[DBRelationshipType], relationships_filter: QueryFilter | None = None
    ) -> List[DBRelationshipType]:
        if not relationships_filter:
            relationships_filter = QueryFilter(type=cls.get_type())
        return await cls._db.get_all_relationships(relationships_filter)

    async def save(self: DBRelationshipType) -> DBRelationshipType:
        return await self._db.save_relationship(self)

    async def update(self: DBRelationshipType) -> DBRelationshipType:
        return await self._db.update_relationship(self)

    @classmethod
    async def create_fulltext_index(cls, vector_field: str):
        await cls._db.create_relationship_fulltext_index(cls.get_type(), vector_field)

    @classmethod
    async def drop_fulltext_index(cls, vector_field: str):
        await cls._db.drop_relationship_fulltext_index(cls.get_type(), vector_field)

    @classmethod
    async def query_fulltext_index(
        cls: type[DBRelationshipType],
        query: str,
        num_of_results: int,
        fulltext_field: str,
        relationships_filter: QueryFilter | None = None,
    ) -> Tuple[List[DBRelationshipType], List[float]]:
        if not relationships_filter:
            relationships_filter = QueryFilter(type=cls.get_type())
        return await cls._db.query_relationship_fulltext_index(
            query, num_of_results, cls.get_type(), fulltext_field, relationships_filter
        )

    @classmethod
    async def create_vector_index(cls, vector_field: str):
        await cls._db.create_relationship_vector_index(cls.get_type(), vector_field)

    @classmethod
    async def drop_vector_index(cls, vector_field: str):
        await cls._db.drop_relationship_vector_index(cls.get_type(), vector_field)

    @classmethod
    async def query_vector_index(
        cls: type[DBRelationshipType],
        query: str,
        num_of_results: int,
        vector_field: str,
        relationships_filter: QueryFilter | None = None,
    ) -> Tuple[List[DBRelationshipType], List[float]]:
        if not relationships_filter:
            relationships_filter = QueryFilter(type=cls.get_type())
        return await cls._db.query_relationship_vector_index(
            query, num_of_results, cls.get_type(), vector_field, relationships_filter
        )
