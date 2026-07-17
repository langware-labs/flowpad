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
    # Flow-graph wiring (FlowManager). Strictly bipartite: both edge types
    # connect a flow_node to a topic, never node↔node.
    # Declared subscription: flow_node → topic (prefix semantics — listening on
    # "a.b" covers the whole "a.b.*" subtree).
    Listens = "listens"
    # Observed emission: flow_node → topic, stamped by FlowManager on first sight.
    Emits = "emits"


class DependsOnKind(StrEnum):
    """SemanticLock check semantics of a DependsOn edge (flow_sdk/semantic_lock).

    COPY: the target must equal a deterministic copier transform of the lock
    content — adjudicated with no LLM. REFLECTION: the target must reflect the
    lock's principles — adjudicated by a reflector subagent (phase 2)."""

    COPY = "copy"
    REFLECTION = "reflection"


class SemanticStatus(StrEnum):
    """Checker verdict persisted on a DependsOn relationship."""

    OK = "ok"
    DRIFT = "drift"             # hash mismatch, not yet adjudicated
    BREAK = "break"             # adjudicated violation
    UNRESOLVABLE = "unresolvable"  # target bytes could not be resolved


class ValidatedBy(StrEnum):
    """Who last aligned the validated hashes on a DependsOn relationship."""

    CHECKER = "checker"
    USER = "user"


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
