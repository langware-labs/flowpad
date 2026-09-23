"""The shapes of a deployment's timeline (``builtin/deployment_timeline``)."""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import ConfigDict

from flow_sdk.schema.data_spec.spec import DataSpec


class TimelineEvent(DataSpec):
    """One thing that happened on a deployment."""

    model_config = ConfigDict(frozen=True)
    spec_kind = "deployment.timeline_event"

    at: datetime
    #: ``message_in`` · ``reply_sent`` · ``turn_started`` · ``turn_failed`` · ``refused``
    kind: str
    who: str = ""
    text: str = ""
    #: The channel it happened on (``whatsapp``, ``http_chat``, ``voice_phone``…) and its source row.
    channel: str = ""
    data_source_id: str = ""
    #: The process it belongs to, and that process's conversation.
    process_id: str = ""
    conversation_id: str = ""
    message_id: str = ""


class DeploymentTimeline(DataSpec):
    """A page of a deployment's timeline, newest first; ``before`` is the next page's cursor."""

    model_config = ConfigDict(frozen=True)
    spec_kind = "deployment.timeline"

    deployment_id: str
    events: list[TimelineEvent]
    before: Optional[datetime] = None
