"""A nano-app: ONE ``.html`` file that is a whole app -- markup, styles, script, and its own manifest.

The file alone is the app, so it can be sent, copied and embedded; it lives anywhere (no asset family,
nothing to index). It reaches Flowpad only through the browser SDK (``sdk.nano.start()``,
``ts_sdk/src/apps/nano.ts``). What makes an ordinary page a nano-app is the manifest it carries::

    <script type="application/json" id="nano-app">{"name": "review", "title": "Review", "input": "crm.lead"}</script>
    <template data-slot="header">{{status}} · {{summary}}</template>
    <template data-slot="block">…</template>
    <main data-slot="page">…</main>

Three slots, one file: ``header`` (one line of text, filled here by ``render_header`` -- never a frame),
``block`` (inside a message or a section) and ``page`` (a tab; the default, and what a bare browser shows).

An opener hands the app one thing, its state key (``flow_sdk/server/page_state.py``): the key names the
message that carries the app, and the value it opens on (``<input kind>.value.json`` on that message) is read
through it -- ``FlowMessage.app_data``.
"""

from __future__ import annotations

import json
import re
from functools import lru_cache
from html.parser import HTMLParser
from typing import Any, ClassVar, Literal, Optional

from flow_sdk.schema.data_spec.spec import DataSpec

NanoSlot = Literal["header", "block", "page"]
#: The manifest's element: ``<script type="application/json" id="nano-app">``.
MANIFEST_ID = "nano-app"
_FIELD = re.compile(r"\{\{\s*([\w.]+)\s*\}\}")


class NanoAppSpec(DataSpec):
    """What a nano-app says about itself, plus the slots its file declares."""

    spec_kind: ClassVar[str] = "nano_app"

    name: str
    title: str = ""
    #: A lucide icon name or an emoji, as the icon picker stores it.
    icon: str = ""
    description: str = ""
    #: The kind of the value the app opens on; None when it opens on nothing.
    input: Optional[str] = None
    #: The slots the file declares (``data-slot``); ``page`` is always one.
    slots: list[NanoSlot] = ["page"]


class NanoAppData(DataSpec):
    """What a nano-app is handed through its state key: the value it opens on and what it kept."""

    #: The value of the kind the manifest names, as ``{spec_kind, ...}``; None when its carrier holds none.
    input: Optional[dict[str, Any]] = None
    #: Plain JSON the app saved on an earlier visit (``app.save``); the app owns its shape.
    saved: Any = None


class _Reader(HTMLParser):
    """One pass over the file: the manifest's text, the slots, and the header template's text."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.manifest: Optional[str] = None
        self.slots: list[str] = []
        self.header: Optional[str] = None
        self._into: Optional[str] = None   # "manifest" | "header" while inside that element

    def handle_starttag(self, tag: str, attrs: list) -> None:
        found = dict(attrs)
        if tag == "script" and found.get("id") == MANIFEST_ID:
            self._into, self.manifest = "manifest", ""
        slot = found.get("data-slot")
        if slot and slot not in self.slots:
            self.slots.append(slot)
        if tag == "template" and slot == "header":
            self._into, self.header = "header", ""

    def handle_endtag(self, tag: str) -> None:
        if (tag == "script" and self._into == "manifest") or (tag == "template" and self._into == "header"):
            self._into = None

    def handle_data(self, data: str) -> None:
        if self._into == "manifest":
            self.manifest = (self.manifest or "") + data
        elif self._into == "header":
            self.header = (self.header or "") + data


@lru_cache(maxsize=8)   # a post reads the same file as its manifest and as its header
def _read(html: str) -> _Reader:
    reader = _Reader()
    reader.feed(html)
    return reader


def read_nano_app(html: str) -> Optional[NanoAppSpec]:
    """The nano-app ``html`` is, or None for an ordinary page (no manifest). A manifest that is not a JSON
    object with a ``name`` raises ``ValueError``: a nano-app that cannot say what it is must not pass silently."""
    reader = _read(html)
    if reader.manifest is None:
        return None
    try:
        said = json.loads(reader.manifest)
    except json.JSONDecodeError as exc:
        raise ValueError(f"the nano-app manifest is not JSON: {exc}") from exc
    if not isinstance(said, dict) or not isinstance(said.get("name"), str) or not said["name"]:
        raise ValueError("the nano-app manifest is an object with a name")
    slots = [slot for slot in ("header", "block") if slot in reader.slots] + ["page"]
    # Field by field: a key the manifest carries that this schema does not model is dropped, not refused.
    return NanoAppSpec(
        name=said["name"], slots=slots, input=said.get("input") or None,
        **{key: str(said.get(key) or "") for key in ("title", "icon", "description")},
    )


def render_header(html: str, data: dict[str, Any]) -> str:
    """The header slot as one line of text: its template with each ``{{field}}`` (``a.b`` reaches inside)
    read from ``data``; a field ``data`` does not have is left out. A file with no header slot answers
    the app's title. Text only -- nothing here is ever run."""
    reader = _read(html)
    if reader.header is None:
        app = read_nano_app(html)
        return (app.title or app.name) if app is not None else ""

    def value(match: re.Match) -> str:
        found: Any = data
        for part in match.group(1).split("."):
            found = found.get(part) if isinstance(found, dict) else None
        return "" if found is None else str(found)

    return " ".join(_FIELD.sub(value, reader.header).split())
