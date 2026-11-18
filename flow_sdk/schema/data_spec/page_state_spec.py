"""``PageState`` — what a page's state key stands for.

A page that runs in Flowpad (a shown HTML file, a mock, an MCP UI, a served app) presents a state
key on every call it makes to the local server; the key names this value. ``context`` is what the
page was opened about, as named typed ids (``{"process": "agentic_process-<id>"}``). ``grant`` is ``app`` for the app's own shell (the only
holder that may mint more keys) and ``page`` for everything it opens.

The value is immutable: a different context is a different key. Live data a page reports about
itself goes through ``setDisplayContext``, not here.
"""

from __future__ import annotations

from typing import ClassVar, Literal

from pydantic import Field

from flow_sdk.schema.data_spec.spec import DataSpec


class PageState(DataSpec):
    spec_kind: ClassVar[str] = "page.state"

    context: dict[str, str] = Field(default_factory=dict)
    grant: Literal["app", "page"] = "page"
    #: What the Allow card and the logs call the page.
    title: str = ""


__all__ = ["PageState"]
