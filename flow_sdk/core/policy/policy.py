import json
import os
import uuid
from typing import Any, Dict, List

from flow_sdk.flowpad_types.enums import AuthRole
from flow_sdk.core.policy.spec import PoliciesSpec
from flow_sdk.request_context.auth_info import AuthContext, AuthResult


def align_policies_json(json_data: Any):
    spec_name = json_data.get("name", None)
    if spec_name is None:
        json_data["name"] = f"file_policy_{str(uuid.uuid4())[:8]}"
    if isinstance(json_data, list):
        json_data = {"policies": json_data}
    return json_data


class PolicyResolver:
    # TODO properties filter of entity type per role should be part of policies (e.g. member vs user)

    def __init__(
        self,
        policies_json: Dict[str, Any] | str | None = None,
        specs_folder: str | None = None,
    ):
        try:
            self.specs: Dict[str, PoliciesSpec] = {}
            self.top_role: str = AuthRole.OWNER.value
            if isinstance(policies_json, dict):
                self.json_data: dict[str, Any] = policies_json
            elif isinstance(policies_json, str):
                self.json_data: dict[str, Any] = json.loads(policies_json)
            else:
                random_name = f"policy_{str(uuid.uuid4())[:8]}"
                self.json_data: dict[str, Any] = {"name": random_name, "policies": {}}
        except Exception as e:
            raise Exception(f"Error loading policies JSON: {e}")

        spec_path = self.json_data.get("spec_path", None)
        if specs_folder is not None:
            if not os.path.isdir(specs_folder):
                raise Exception(f"Specs folder not found: {specs_folder}")
            self.specs_folder = specs_folder
        elif spec_path is not None:
            if os.path.isfile(spec_path):
                self.specs_folder = os.path.dirname(spec_path)
        else:
            self.specs_folder = os.path.dirname(os.path.abspath(__file__))

        self.main_spec: PoliciesSpec = PoliciesSpec.model_validate(self.json_data)
        # self.load_base_specs() # not in use at the
        # self._parse_json()
        # print("Policies JSON:", policies_json)
        # print("Loaded Policies:", self.policies)

    @classmethod
    def from_spec_file(cls, policies_json_path: str) -> "PolicyResolver":
        if not isinstance(policies_json_path, str) or not os.path.isfile(policies_json_path):
            raise Exception(f"Invalid policies JSON path: {policies_json_path}")
        with open(policies_json_path) as f:
            policies_json = json.load(f)
        policies_json["spec_path"] = policies_json_path
        return cls(policies_json)

    def is_allowed_action(self, auth_context: AuthContext, roles: str | List[str]) -> AuthResult:
        if not isinstance(roles, list):
            roles = [roles]
        if not self.main_spec:
            return AuthResult(allowed=False, reason="no policies defined")
        return self.main_spec.is_allowed_action(auth_context, roles)


# Example spec
example_spec = {
    "name": "example_spec",
    "entities_policies": {
        "organization": {
            "roles": {
                "owner": {
                    "extend_role": "admin",
                    "allow": ["delete"],
                    "forbid": ["removeMember"],
                },
                "admin": {
                    "extend_role": "editor",
                    "allow": ["addMember", "removeMember"],
                },
                "editor": {"extend_role": "guest", "allow": ["write"]},
                "guest": {"allow": ["read"]},
            },
        },
        "team": {
            "roles": {
                "owner": {"extend_role": "admin", "allow": ["delete"]},
                "admin": {
                    "extend_role": "editor",
                    "allow": ["addMember", "removeMember"],
                },
                "editor": {"extend_role": "guest", "allow": ["write"]},
                "guest": {"allow": ["read"]},
            },
        },
    },
}
