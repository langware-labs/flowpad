import fnmatch
from flow_sdk._compat import StrEnum
from typing import Any, Dict, List, Optional, TypeAlias

from pydantic import BaseModel

from flow_sdk.actions import action
from flow_sdk.request_context.auth_info import AuthContext, AuthResult

Role: TypeAlias = str
ActionName: TypeAlias = str
PolicyEntityType: TypeAlias = str


class PolicySource(StrEnum):
    COMMON_POLICY = "base_policy"
    ENTITY_POLICY = "entity_policy"


# ActionPolicy: TypeAlias = Union[ActionName, "ActionMatch"]


class ActionPolicy(BaseModel):
    action: ActionName
    method: str
    subpath_glob: Optional[str] = None

    def is_match(self, context: AuthContext) -> bool:
        if self.method != "*" and self.method != context.method:
            return False
        if self.subpath_glob is not None:
            sub_path = context.sub_path or ""
            if not fnmatch.fnmatch(sub_path, self.subpath_glob):
                return False
        if self.action != "*" and self.action != context.action:
            return False
        return True


def align_actions(actions: List[str] | List[ActionPolicy]) -> List[ActionPolicy]:
    aligned_actions: List[ActionPolicy] = []
    for role_action in actions:
        if isinstance(role_action, str):
            aligned_actions.append(ActionPolicy(action=role_action, method="*", subpath_glob="*"))
        elif isinstance(role_action, ActionPolicy):
            aligned_actions.append(role_action)
        elif isinstance(role_action, dict):
            aligned_actions.append(ActionPolicy(**role_action))
        else:
            raise TypeError(f"Unsupported action type: {type(role_action)}. Expected str or ActionPolicy.")
    return aligned_actions


ROLE_PLACEHOLDER = "unknown_role_placeholder"


class RolePolicy(BaseModel):
    def __init__(self, **kwargs):
        allow = kwargs.get("allow", [])
        if allow:
            kwargs["allow"] = align_actions(allow)
        forbid = kwargs.get("forbid", [])
        if forbid:
            kwargs["forbid"] = align_actions(forbid)
        super().__init__(**kwargs)

    _role: Role = ROLE_PLACEHOLDER
    source: Optional[PolicySource] = None
    extend_role: Optional[Role] = None
    allow: List[ActionPolicy] = []
    forbid: Optional[List[ActionPolicy]] = None

    @property
    def role(self) -> Role:
        if self._role == ROLE_PLACEHOLDER:
            raise ValueError("Role is not set")
        return self._role

    @role.setter
    def role(self, value: Role):
        self._role = value

    def __repr__(self) -> str:
        if self.allow:
            allow_str = ",".join([str(allowed_action.action) for allowed_action in self.allow])
        else:
            allow_str = "Empty"
        if self.forbid:
            forbid_str = ",".join([str(forbidden_action.action) for forbidden_action in self.forbid])
        else:
            forbid_str = "Empty"
        return f"RolePolicy(role={self._role}, extend_role={self.extend_role}, source={self.source}, allow={allow_str}, forbid={forbid_str})"


class EntityPolicy(BaseModel):
    roles: Dict[Role, RolePolicy] = {}
    source: Optional[PolicySource] = None
    entity_type: Optional[PolicyEntityType] = None

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        for role, role_policy in self.roles.items():
            role_policy.role = role
            if role_policy.extend_role:
                if role_policy.extend_role not in self.roles:
                    role_names = [role for role in self.roles.keys()]
                    raise IndexError(
                        f"Missing extended role {role_policy.extend_role} , entity_type: {self.entity_type}, source spec: {self.source}, existing roles {role_names}"
                    )

    def get_role_policy_chain(self, role: Role) -> List[RolePolicy]:
        chain: List[RolePolicy] = []
        current_role = role
        while current_role is not None:
            current_role_policy: RolePolicy | None = self.roles.get(current_role, None)
            if current_role_policy is not None:
                current_role_policy.source = self.source
                chain.append(current_role_policy)
                current_role = current_role_policy.extend_role
                continue
            current_role = None
        chain.reverse()
        return chain


class PoliciesSpec(BaseModel):
    name: str
    default_policy: Optional[EntityPolicy] = None
    entities_policies: Dict[PolicyEntityType, EntityPolicy] = {}
    spec_path: Optional[str] = None
    raw_data: Optional[dict[str, Any]] = None

    def __init__(self, **kwargs):
        default_policy = kwargs.get("default_policy", None)
        if isinstance(default_policy, dict):
            default_policy["source"] = PolicySource.COMMON_POLICY
            default_policy["entity_type"] = "*all*"
        entities_policies = kwargs.get("entities_policies", {})
        for entity_type, entity_policy in entities_policies.items():
            entity_policy["source"] = PolicySource.ENTITY_POLICY
            entity_policy["entity_type"] = entity_type
        super().__init__(**kwargs)
        self.raw_data = kwargs

    def _get_role_policy_chain(self, entity_type: str, role: str) -> List[RolePolicy]:
        role_policies_chain: List[RolePolicy] = []
        entity_policy: EntityPolicy | None = self.entities_policies.get(entity_type, None)
        default_policy_role = role
        if entity_policy:
            entity_policy_chain = entity_policy.get_role_policy_chain(role)
            role_policies_chain = entity_policy_chain
            if len(entity_policy_chain) > 0:
                default_policy_role = entity_policy_chain[0].role
        if self.default_policy is not None:
            default_policy_chain = self.default_policy.get_role_policy_chain(default_policy_role)
            role_policies_chain = default_policy_chain + role_policies_chain

        return role_policies_chain

    @classmethod
    def _is_chain_allowed(cls, chain: List[RolePolicy], auth_context: AuthContext) -> bool:
        allowed = False
        for role_policy in chain:
            for action_policy in role_policy.allow:
                if action_policy.is_match(auth_context):
                    allowed = True
            if role_policy.forbid:
                for action_policy in role_policy.forbid:
                    if action_policy.is_match(auth_context):
                        allowed = False
        return allowed

    @classmethod
    def _get_allowed_actions_approximation(cls, chain: List[RolePolicy]) -> List[str]:
        all_possible_actions = action.get_all_actions_names()
        none_validated_allowed_actions: List[str] = []  # glob was not validated
        for role_policy in chain:
            for allowed_action_policy in role_policy.allow:
                # append if not in none_validated_allowed_actions
                if allowed_action_policy.action == "*":
                    none_validated_allowed_actions.extend(all_possible_actions)
                    # make sure unique
                    none_validated_allowed_actions = list(set(none_validated_allowed_actions))
                elif allowed_action_policy.action not in none_validated_allowed_actions:
                    none_validated_allowed_actions.append(allowed_action_policy.action)
            if role_policy.forbid:
                for forbidden_action_policy in role_policy.forbid:
                    if forbidden_action_policy.action == "*":
                        none_validated_allowed_actions = []
                    elif forbidden_action_policy.action in none_validated_allowed_actions:
                        none_validated_allowed_actions.remove(forbidden_action_policy.action)
        return none_validated_allowed_actions

    def get_allowed_actions(self, auth_context: AuthContext, roles: str | List[str]) -> List[str]:
        if not isinstance(roles, list):
            roles = [roles]
        if auth_context.resource_type is None:
            return []
        allowed_actions: List[str] = []
        for role in roles:
            role_policies_chain: List[RolePolicy] = self._get_role_policy_chain(auth_context.resource_type, role)
            none_validated_allowed_actions = self._get_allowed_actions_approximation(role_policies_chain)
            allowed_actions.extend(none_validated_allowed_actions)
        return allowed_actions

    def is_allowed_action(self, auth_context: AuthContext, roles: str | List[str]) -> AuthResult:
        if not isinstance(roles, list):
            roles = [roles]
        if auth_context.resource_type is None:
            return AuthResult(allowed=False, reason="resource type is not set")

        allowed_actions: List[str] = []
        approved_roles: List[str] = []
        for role in roles:
            role_policies_chain: List[RolePolicy] = self._get_role_policy_chain(auth_context.resource_type, role)
            none_validated_allowed_actions = self._get_allowed_actions_approximation(role_policies_chain)
            # unique merge
            allowed_actions.extend(none_validated_allowed_actions)
            allowed_actions = list(set(allowed_actions))
            if self._is_chain_allowed(role_policies_chain, auth_context):
                approved_roles.append(role)
        if len(approved_roles) > 0:
            return AuthResult(
                allowed=True,
                reason=f"valid access for role {approved_roles}",
                target_allowed_actions=allowed_actions,
            )
        return AuthResult(
            allowed=False,
            reason=f"no valid access for role {roles}, entity_type: {auth_context.resource_type}, action: {auth_context.action}",
            target_allowed_actions=allowed_actions,
        )
