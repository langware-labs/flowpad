from flow_sdk._compat import StrEnum


class RelationshipDirection(StrEnum):
    Outgoing = "outgoing"
    Incoming = "incoming"
    Both = "both"


class BuiltInRelationshipTypes(StrEnum):
    ConnectedTo = "connectedto"
    ConnectedThrough = "connectedthrough"
    HostedBy = "hostedby"
    InvitedThrough = "invitedthrough"
    InvitedBy = "invitedby"
    Role = "role"
    DependsOn = "dependson"


class ExpansionType(StrEnum):
    Permissions = "permissions"
    IsPrivate = "is_private"
    Blobs = "blobs"
    AuthScopes = "auth_scopes"


class EnvOpType(StrEnum):
    """Operation type for flow-env-var messages."""

    PENDING = "pending"  # Default: user input expected
    CREATED = "created"  # Notification: env var was created
    UPDATED = "updated"  # Notification: env var was updated
    DELETED = "deleted"  # Notification: env var was deleted
