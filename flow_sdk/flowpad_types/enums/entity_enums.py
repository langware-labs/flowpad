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


class CrudAction(StrEnum):
    """Standard CRUD action names for cross-user notifications."""
    CREATE = "create"
    READ = "read"
    UPDATE = "update"
    DELETE = "delete"


class NotificationType(StrEnum):
    """High-level category of a cross-user notification."""
    RESOURCE_ACTION = "resource_action"
    ALERT = "alert"
    USER_MESSAGE = "user_message"


class DeliveryMethod(StrEnum):
    EMAIL = "email"
    SLACK = "slack"
    JIRA = "jira"


class NotificationStatus(StrEnum):
    PENDING = "pending"
    SENT = "sent"
    RECEIVED = "received"
