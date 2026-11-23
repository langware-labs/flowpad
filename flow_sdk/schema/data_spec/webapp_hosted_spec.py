"""What Flowpad serves right now, and who has it open: the Hosted apps tab of the activity panel.

Two values, neither stored: a ``webapp.page_presence`` lives as long as its page's socket
(``core/webapp/presence``), and a ``webapp.hosted`` is built on every read from the app's row, its lifecycle
record and those connections.
"""

from __future__ import annotations

from datetime import datetime
from typing import ClassVar, Literal, Optional

from pydantic import Field

from flow_sdk.schema.data_spec.spec import DataSpec

#: Where a page is open. ``flowpad``: inside a Flowpad tab; ``agent``: the agent browser's window; else the
#: browser's own family, read from its User-Agent.
Browser = Literal["flowpad", "agent", "chrome", "edge", "firefox", "safari", "other"]


class PagePresence(DataSpec):
    """One open page of a served app — a live connection."""

    spec_kind: ClassVar[str] = "webapp.page_presence"

    webapp_id: str
    endpoint_id: str = ""
    #: The page inside the app (``/leads``), never the address Flowpad serves it at.
    path: str = "/"
    browser: Browser = "other"
    #: The session that showed the page (``agentic_process-<id>``); ``""``: the person opened it.
    opened_by: str = ""
    since: datetime


class HostedAppSpec(DataSpec):
    """One app this machine serves now, with its live connections."""

    spec_kind: ClassVar[str] = "webapp.hosted"

    webapp_id: str
    title: str
    project_id: str = ""
    state: str
    since: Optional[datetime] = None
    #: The page's own port and process; None for files Flowpad serves itself.
    port: Optional[int] = None
    pid: Optional[int] = None
    connections: list[PagePresence] = Field(default_factory=list)
