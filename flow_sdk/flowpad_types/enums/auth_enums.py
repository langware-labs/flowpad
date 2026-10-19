from enum import Enum

from flow_sdk._compat import StrEnum


class BuiltInConstant(StrEnum):
    UnknownUserId = "unknown"
    SystemUserId = "system"


class AuthRole(Enum):
    READER = "READER"
    EDITOR = "EDITOR"
    ADMIN = "ADMIN"
    OWNER = "OWNER"
    GUEST = "GUEST"
    ANONYMOUS_VIEWER = "ANONYMOUS_VIEWER"


VISITOR_AUTH_ROLE = AuthRole.ANONYMOUS_VIEWER


class HubRole(StrEnum):
    """Roles as the HUB names them on the wire — the lowercase vocabulary that
    goes into a ``MembershipRequest``'s ``invitation_targets``.

    Deliberately separate from ``AuthRole`` above (the uppercase, internal
    policy vocabulary): these values are a protocol, and a ``.lower()`` bridge
    between the two would hide that. Use this wherever a role string is sent to
    the hub, instead of a bare literal.
    """

    OWNER = "owner"
    ADMIN = "admin"
    EDITOR = "editor"
    MEMBER = "member"
    READER = "reader"
    GUEST = "guest"
