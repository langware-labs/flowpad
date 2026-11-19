"""Filesystem contracts independent of application entities."""
from flow_sdk._compat import StrEnum


#: The seeded rule that stands for the message classifier (its ``uname``): the first entry of each
#: arriving message's queue, switched like any rule, never armed on the bus.
MESSAGE_CLASSIFIER = "builtin_message_classifier"


class TriggerType(StrEnum):
    """Discriminator for Trigger entities. New values: extend here + handle in lifecycle hooks."""

    HOOK = "hook"
    SCHEDULE = "schedule"
    FSOP = "fsop"
    # A unified-bus subscription (docs/flow-events.md phase 4): fires on
    # matching FlowEvents instead of files/cron/hooks.
    TAG = "tag"
