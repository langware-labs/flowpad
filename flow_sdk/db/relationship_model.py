from typing import TypeVar
from flow_sdk._compat import Unpack

from pydantic import ConfigDict

from flow_sdk.flowpad_types.enums import BuiltInRelationshipTypes
from flow_sdk.db.db_relationship import DBRelationship

RelationshipType = TypeVar("RelationshipType", bound="DBRelationship")


class Relationship(DBRelationship):
    model_config = ConfigDict(from_attributes=True, arbitrary_types_allowed=True)

    def __init_subclass__(cls, **kwargs: Unpack[ConfigDict]):
        super().__init_subclass__(**kwargs)


class InvitedThroughRelationship(Relationship):
    type: str = BuiltInRelationshipTypes.InvitedThrough.value
    invited_to_role: str


class DependsOnRelationship(Relationship):
    type: str = BuiltInRelationshipTypes.DependsOn.value


class ConnectedThroughRelationship(Relationship):
    type: str = BuiltInRelationshipTypes.ConnectedThrough.value


class HostedByRelationship(Relationship):
    type: str = BuiltInRelationshipTypes.HostedBy.value


class InvitedByRelationship(Relationship):
    type: str = BuiltInRelationshipTypes.InvitedBy.value
