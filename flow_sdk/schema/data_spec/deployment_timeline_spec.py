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


class DeploymentThread(DataSpec):
    """One conversation a deployment holds — a chat, a mail thread, a whole phone call.

    ``status``: ``live`` (a call is on the line now), ``working`` (the agent is mid-turn in it),
    ``ended`` (a call that is over), ``idle`` (nothing happening).
    """

    model_config = ConfigDict(frozen=True)
    spec_kind = "deployment.thread"

    conversation_id: str
    title: str = ""
    #: Who the agent talks to in it (the first other party), and on which channel.
    who: str = ""
    channel: str = ""
    data_source_id: str = ""
    #: The newest process working in it — its chat is the agent's side of the thread.
    process_id: str = ""
    status: str = "idle"
    started_at: Optional[datetime] = None
    last_at: Optional[datetime] = None
    last_text: str = ""
    messages: int = 0
    turns: int = 0


class DeploymentThreads(DataSpec):
    """A deployment's threads, the most recently active first."""

    model_config = ConfigDict(frozen=True)
    spec_kind = "deployment.threads"

    deployment_id: str
    threads: list[DeploymentThread]


class DeploymentProcess(DataSpec):
    """A local deployment's process: the Python file it runs and the terminal it runs in."""

    model_config = ConfigDict(frozen=True)
    spec_kind = "deployment.process"

    deployment_id: str
    #: The ``Shell`` whose terminal runs it — what the page shows; empty before its first start.
    shell_id: str = ""
    #: The file, and the command typed to run it.
    file: str = ""
    command: str = ""
    #: The loop's pid while it runs (``None`` when nothing does).
    pid: Optional[int] = None
    #: Whether the deployment is on (the supervisor keeps an "on" one running).
    serving: bool = False


class DeploymentCode(DataSpec):
    """The text of the file a local deployment runs."""

    model_config = ConfigDict(frozen=True)
    spec_kind = "deployment.code"

    file: str
    text: str
