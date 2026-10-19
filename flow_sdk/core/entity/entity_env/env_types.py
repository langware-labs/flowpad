from __future__ import annotations

from typing import Generic, List, Optional, TypeVar

from pydantic import BaseModel, Field

from flow_sdk._compat import StrEnum
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.fs_store.type_id import TypeId

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

    # OAuth catalogue protocol metadata. ``1`` is the correlated auth/wait/
    # cancel + strict verification contract consumed by every connection UI.
    oauth_display_name: Optional[str] = None
    oauth_verifiable: Optional[bool] = None
    oauth_protocol: Optional[int] = None

    # API Key reference
    key_id: Optional[str] = None  # Reference to ApiKey entity ID (connects env_var to its API key in SOD)

    # --- OAUTH_PROVIDER_ID rows only ------------------------------------------
    # What a user needs to judge a connection before granting it: which OAuth
    # grant will run, and what it will be allowed to do. Both were invisible,
    # so "Connect" was a button with undisclosed consequences.
    #: The OAuth grant this provider uses — see ``OAuthFlowKind``.
    oauth_kind: Optional[str] = None
    #: The scopes the flow will request. Empty when the side that owns the flow
    #: does not publish them (a hub provider's scopes live in its manifest).
    oauth_scopes: list[str] = []
    #: Epoch seconds the held access token expires; None when the provider never
    #: said, which means "does not expire".
    expires_at: Optional[int] = None
    #: The refresh was permanently refused — the credential is held but dead, and
    #: only a new grant fixes it. Mirrors the hub's field of the same name so a
    #: hub-held credential can say so here; deliberately separate from
    #: ``var_status``, which answers "may this project use it", not "does it work".
    needs_reauth: bool = False

    # --- WHOSE account this credential belongs to -----------------------------
    # Latest login wins, which is right — but until now nothing recorded WHICH
    # account won. Re-connecting a provider as a different account silently
    # repointed every consumer that had been granted the old one, and every
    # status still read AVAILABLE because the table only checks that a
    # name-matching row exists.
    #
    # `account_key` is an opaque provider-side id, never the token and never a
    # display string: comparison has to be exact, and a human-readable label
    # would put PII in a row that travels.
    #: The provider account the currently-held token belongs to. None when the
    #: provider does not say — and None must never compare equal to a set value.
    account_key: Optional[str] = None
    #: Epoch seconds of the grant that produced the currently-held token.
    connected_at: Optional[int] = None
    #: On a BORROWER's reference row: the account that was consented to. Compared
    #: against the owner's `account_key` at status time; a mismatch means the
    #: consent on file was for someone else.
    bound_account_key: Optional[str] = None

    # EVERY predicate here is a property, and that uniformity is the point.
    # `is_key` and `is_plain` were plain methods while their siblings were
    # properties, so `if var.is_plain or var.is_key:` in `resolve_var_status`
    # tested two bound METHOD OBJECTS — always truthy. That branch therefore ran
    # for every row of every type, `EnvStatusEnum.NA` became unreachable, and an
    # OAUTH_TOKEN row was judged by `visible_value` (None on a token row) and
    # reported MISSING. Nothing raised; the status was just wrong.
    #
    # A mixed convention on same-shaped predicates is what made that invisible at
    # the call site. Do not add a zero-argument predicate here as a method.

    @property
    def is_ref(self) -> bool:
        return self.ref_type is not None

    @property
    def is_oauth_provider(self) -> bool:
        return self.var_type == EnvVarType.OAUTH_PROVIDER_ID

    @property
    def is_key(self) -> bool:
        return self.var_type == EnvVarType.API_KEY

    @property
    def is_flowpad_api_key(self) -> bool:
        """Check if this is a FlowPad API key (has key_id reference)"""
        return self.key_id is not None

    @property
    def is_plain(self) -> bool:
        return self.var_type == EnvVarType.PLAIN

    @property
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
