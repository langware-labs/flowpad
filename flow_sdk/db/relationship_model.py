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
    """A ``lock → target`` dependency edge, doubling as the SemanticLock
    changed-cache (flow_sdk/semantic_lock).

    Extra fields persist through the relationship ``data`` JSON blob — the
    sqlite driver skips ``None`` values on dump, so every field here keeps a
    non-None default (``""`` / ``{}``).
    """

    type: str = BuiltInRelationshipTypes.DependsOn.value
    # SemanticLock check semantics — a DependsOnKind value ("" = plain edge,
    # not semantic-checked).
    kind: str = ""
    # Role-keyed validated hashes: {"target": sha256, "lock": sha256,
    # "reflector": sha256}. Staleness = ANY role's current hash differs.
    # A dict (not a list) — frontend deepAssign corrupts shrinking lists.
    validated_hashes: dict = {}
    # SemanticStatus value; "" = never checked.
    status: str = ""
    # ValidatedBy value + ISO timestamp of the last hash alignment.
    validated_by: str = ""
    validated_at: str = ""
    # Last adjudication detail (reason, line anchors) when status == "break".
    break_detail: dict = {}
    # Heal-pass anchors: enough to re-anchor the target after a rename or a
    # machine→git identity migration (content-hash pairing, phase 2).
    target_rel_path: str = ""
    target_abs_path: str = ""
    target_repo_key: str = ""


class ConnectedThroughRelationship(Relationship):
    type: str = BuiltInRelationshipTypes.ConnectedThrough.value



class HostedByRelationship(Relationship):
    type: str = BuiltInRelationshipTypes.HostedBy.value


class InvitedByRelationship(Relationship):
    type: str = BuiltInRelationshipTypes.InvitedBy.value
