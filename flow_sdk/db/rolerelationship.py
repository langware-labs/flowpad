import string

from flow_sdk.flowpad_types.enums import BuiltInRelationshipTypes
from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.db.relationship_model import Relationship

char_set = string.ascii_lowercase + string.digits


class RoleRelationship(Relationship):
    type: str = APIField(default=BuiltInRelationshipTypes.Role.value)
    from_role: str | None = None
    to_role: str | None = None
    # TODO use some sort of "stop propagation" filter (e.g. is_final, only_for_user_id, etc.)
    is_final: bool = False
    is_child: bool | None = None
    invitation: TypeId | None = None

    def set_mapping(self, from_role: str, to_role: str):
        self.from_role = from_role
        self.to_role = to_role
        return self

    def get_mapping(self, from_role: str):
        from_role = from_role.lower()
        if from_role != self.from_role:
            if self.from_role == "*" and self.to_role == "*":
                return from_role
            if self.from_role == "*":
                return self.to_role
            return None
        return self.to_role
