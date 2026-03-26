from __future__ import annotations

from flow_sdk._compat import StrEnum
from typing import Generic, List, Optional, TypeVar

from pydantic import BaseModel, Field

from flow_sdk.api.api_types.type_id import TypeId
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType

TEST_PROVIDER = "test_provider"


class EnvStatusEnum(StrEnum):
    NA = "NA SOD"  # Not applicable (for non-refs)
    AVAILABLE = "AVAILABLE"  # We have the key, and we have consent to use it (what used to be CONNECTED)
    MISSING = "MISSING"  # We don't have the key
    CONSENT_REQUIRED = "CONSENT_REQUIRED"  # We have the key, but need consent to share it
    ERROR = "ERROR"


class EnvVarType(StrEnum):
    API_KEY = "api_key"
    OAUTH_TOKEN = "oauth_token"
    OAUTH_PROVIDER_ID = "oauth_provider"  # special type for oauth providers (not a secret, just a pointer)
    PLAIN = "plain"


class EnvVar(BaseModel):
    name: str  # in project (i.e. in EnvVarTable): slack_in_user, is user (i.e., in connection table): slack
    description: Optional[str] = None
    var_type: EnvVarType = EnvVarType.PLAIN
    visible_value: Optional[str] = None  # actual value for non-confidential, 4 digits for confidential
    allowed_to_use: list[TypeId] = []  # who do I allow to use this var
    ref_type: Optional[BuiltinEntityType] = (
        None  # pointer (ref). for oauth this is None, bcs we don't point to ourselves
    )
    ref_name: Optional[str] = (
        None  # name of the sod in the location, for oauth this is None, bcs we don't point to ourselves
    )
    icon: Optional[str] = None  # icon to show in UI

    # API Key reference
    key_id: Optional[str] = None  # Reference to ApiKey entity ID (connects env_var to its API key in SOD)

    @property
    def is_ref(self) -> bool:
        return self.ref_type is not None

    @property
    def is_oauth_provider(self) -> bool:
        return self.var_type == EnvVarType.OAUTH_PROVIDER_ID

    def is_key(self) -> bool:
        return self.var_type == EnvVarType.API_KEY

    def is_flowpad_api_key(self) -> bool:
        """Check if this is a FlowPad API key (has key_id reference)"""
        return self.key_id is not None

    def is_plain(self) -> bool:
        return self.var_type == EnvVarType.PLAIN

    def has_key_id(self) -> bool:
        """Check if this env_var is linked to an API key"""
        return self.key_id is not None

    def share_with(self, attachment: TypeId):
        if attachment not in self.allowed_to_use:
            self.allowed_to_use.append(attachment)

    def revoke_from(self, attachment: TypeId):
        if attachment in self.allowed_to_use:
            self.allowed_to_use.remove(attachment)

    def is_allowed(self, attachment: TypeId) -> bool:
        if attachment in self.allowed_to_use:
            return True
        return False

    @property
    def get_name(self) -> Optional[str]:
        if self.var_type == EnvVarType.OAUTH_TOKEN:
            return self.ref_name
        return None


class EnvVarStatus(EnvVar):
    var_status: Optional[EnvStatusEnum] = EnvStatusEnum.NA


T = TypeVar("T", EnvVar, EnvVarStatus)


class EntityEnvVars(BaseModel, Generic[T]):
    values: List[T] = Field(default_factory=list)

    def __iter__(self):
        return iter(self.values)

    def append(self, var: T):
        self.values.append(var)

    def remove(self, var: T):
        if var in self.values:
            self.values.remove(var)
            return
        raise ValueError(f"Variable with name {var.name} not found")

    def update(self, var: T):
        for i, existing_var in enumerate(self.values):
            if existing_var.name == var.name:
                self.values[i] = var
                return
        raise ValueError(f"Variable with name {var.name} not found")

    def update_value(self, var_name: str, new_value: str):
        var = self.get_var(var_name)
        if not var:
            raise ValueError(f"Variable with name {var_name} not found")
        var.visible_value = new_value

    def get_var(self, var_name: str) -> T | None:
        for var in self.values:
            if var.name == var_name:
                return var
        return None

    def to_string(self) -> str:
        """Convert the env vars table to a formatted string representation."""
        if not self.values:
            return ""

        lines = []
        for idx, var in enumerate(self.values, start=1):
            lines.append(f"#{idx}:")
            for field_name, field_value in var.model_dump().items():
                if field_value is None or (isinstance(field_value, list) and len(field_value) == 0):
                    continue

                if isinstance(field_value, list):
                    formatted_value = ", ".join(str(item) for item in field_value)
                else:
                    # Pydantic model_dump() should already convert enums to their values
                    formatted_value = str(field_value)

                lines.append(f"     {field_name}: {formatted_value}")

            lines.append("")

        return "\n".join(lines)
