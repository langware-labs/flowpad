"""Filesystem contracts independent of application entities."""
from flow_sdk._compat import StrEnum


class TriggerType(StrEnum):
    """Discriminator for Trigger entities. New values: extend here + handle in lifecycle hooks."""

    HOOK = "hook"
    SCHEDULE = "schedule"
    FSOP = "fsop"
    # A unified-bus subscription (docs/flow-events.md phase 4): fires on
    # matching FlowEvents instead of files/cron/hooks.
    TAG = "tag"
