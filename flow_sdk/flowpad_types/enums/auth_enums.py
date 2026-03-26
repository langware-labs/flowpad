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
