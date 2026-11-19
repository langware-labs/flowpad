"""Who has a served page open — the live connections of the apps this machine serves.

Every HTML page Flowpad serves carries :func:`script_tag`: the page opens ONE socket and keeps it for as long
as it is open. The socket IS the fact — open, the page is listed; closed, it is gone. Nothing is stored, polled
or timed out, so a backend restart starts empty and a page is listed again when it is loaded again.

Two doors, one registry: a page served on the backend's own origin (``…/service_endpoint/<id>/service/…``)
dials the endpoint's ``presence`` route; a dev server's page, loaded through its reporter relay
(``server/reporter_relay``), dials the relay at :data:`RELAY_PATH`. :func:`hosted` is what a screen reads.
"""

from __future__ import annotations

import asyncio
import itertools
import json
import logging
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import urldefrag

from starlette.websockets import WebSocket, WebSocketDisconnect

from flow_sdk.schema.data_spec.webapp_hosted_spec import Browser, HostedAppSpec, PagePresence

logger = logging.getLogger(__name__)

#: The FlowData element that tells a screen the hosted list changed; it carries nothing, the screen re-reads.
HOSTED_ELEMENT = "hosted_apps"
#: Where a relayed page dials (the relay answers it, never the dev server).
RELAY_PATH = "/__flowpad/presence"

_SCRIPT = """<script>(() => {
  if (window.__flowpadPresence) return;
  window.__flowpadPresence = true;
  const relay = %(relay)s;
  const served = location.pathname.match(/^(.*\\/service_endpoint\\/[^/]+)\\/service(\\/.*)?$/);
  if (!relay && !served) return;
  const key = globalThis.__FLOWPAD_STATE_KEY__ || new URLSearchParams(location.search).get('state') || '';
  const origin = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
  const url = relay ? origin + '%(relay_path)s'
    : origin + served[1] + '/presence?path=' + encodeURIComponent(served[2] || '') + (key ? '&state=' + encodeURIComponent(key) : '');
  let socket;
  try { socket = new WebSocket(url); } catch (_) { return; }
  const say = () => { if (socket.readyState === 1) socket.send(JSON.stringify({ href: location.href,
    path: location.pathname + location.hash, embedded: window.parent !== window, state_key: key })); };
  socket.addEventListener('open', say);
  addEventListener('popstate', say);
  addEventListener('hashchange', say);
})();</script>"""


def script_tag(*, relay: bool = False) -> str:
    """The script a served page carries. ``relay``: the page is a dev server's, loaded through its relay."""
    return _SCRIPT % {"relay": "true" if relay else "false", "relay_path": RELAY_PATH}


_pages: dict[int, PagePresence] = {}
_handles = itertools.count(1)


def of(webapp_id: str) -> list[PagePresence]:
    """The open pages of one app, oldest first."""
    return sorted((p for p in _pages.values() if p.webapp_id == _bare(webapp_id)), key=lambda p: p.since)


def add(page: PagePresence) -> int:
    handle = next(_handles)
    _pages[handle] = page
    return handle


def move(handle: int, path: str) -> None:
    """The page went somewhere else inside its app."""
    page = _pages.get(handle)
    if page is not None:
        _pages[handle] = page.model_copy(update={"path": path})


def remove(handle: int) -> None:
    _pages.pop(handle, None)


def reset_for_tests() -> None:
    _pages.clear()


def _bare(webapp_id: Optional[str]) -> str:
    return str(webapp_id or "").removeprefix("micro_app-")


async def announce() -> None:
    """Tell every screen the hosted list changed. Best effort: a screen that misses it reads on its next open."""
    try:
        from flow_sdk.activity.emit import local_subject_typeid  # noqa: PLC0415
        from flow_sdk.core.network.resource_tracker import broadcast_progress  # noqa: PLC0415

        await broadcast_progress(local_subject_typeid(), {"element_type": HOSTED_ELEMENT, "attributes": {}})
    except Exception as exc:  # noqa: BLE001 — no socket, no server: nobody to tell
        logger.debug("hosted-apps push failed: %s", exc)


def browser_family(user_agent: str) -> Browser:
    """The browser a User-Agent names. Order matters: Edge and Electron both also say Chrome, Chrome says Safari."""
    agent = user_agent or ""
    for mark, family in (("Electron/", "flowpad"), ("Edg/", "edge"), ("Firefox/", "firefox"), ("Chrome/", "chrome"),
                         ("Safari/", "safari")):
        if mark in agent:
            return family  # type: ignore[return-value]
    return "other"


async def _browser(user_agent: str, embedded: bool, href: str) -> Browser:
    if embedded:
        return "flowpad"
    family = browser_family(user_agent)
    if family == "chrome" and href:
        from flow_sdk.core import agent_browser  # noqa: PLC0415

        if urldefrag(href).url in await asyncio.to_thread(agent_browser.open_urls):
            return "agent"
    return family


def _opener(state_key: str) -> str:
    """The session that showed the page: the one its state key was minted for (``navigate.with_state_key``)."""
    from flow_sdk.server import page_state  # noqa: PLC0415

    state = page_state.lookup(state_key)
    return str(state.context.get("process") or "") if state is not None else ""


async def hold(websocket: WebSocket, *, webapp_id: str, endpoint_id: str = "", served_at: str = "") -> None:
    """Keep one page's socket: list the page while it is open. ``served_at`` is the address prefix the app is
    served under, taken off what the page reports so a path is the app's own."""
    await websocket.accept()
    handle: Optional[int] = None
    try:
        while True:
            try:
                said = json.loads(await websocket.receive_text())
            except ValueError:
                continue
            path = str(said.get("path") or "/")
            if served_at and path.startswith(served_at):
                path = path[len(served_at):] or "/"
            if handle is None:
                handle = add(PagePresence(
                    webapp_id=_bare(webapp_id),
                    endpoint_id=endpoint_id,
                    path=path,
                    browser=await _browser(websocket.headers.get("user-agent", ""), bool(said.get("embedded")),
                                           str(said.get("href") or "")),
                    opened_by=_opener(str(said.get("state_key") or "")),
                    since=datetime.now(timezone.utc),
                ))
            else:
                move(handle, path)
            await announce()
    except WebSocketDisconnect:
        pass
    finally:
        if handle is not None:
            remove(handle)
            await announce()


def served_at(endpoint_id: str, mount: Optional[str]) -> str:
    """The address prefix a route's pages are served under — what a reported path loses to become the app's own."""
    from flow_sdk.server.service_proxy import service_path  # noqa: PLC0415

    return service_path(endpoint_id).rstrip("/") + (f"/{mount}" if mount else "")


async def hold_for_port(websocket: WebSocket, port: int) -> None:
    """A relayed page's socket: the page is of the app whose process this machine serves on ``port``."""
    from flow_sdk.builtin import webapp_placement  # noqa: PLC0415

    for placed in await webapp_placement.served_routes():
        if placed.backend.type == "proxy" and int(placed.backend.port) == int(port) and placed.webapp_id:
            await hold(websocket, webapp_id=placed.webapp_id, endpoint_id=placed.id,
                       served_at=served_at(placed.id, placed.mount))
            return
    await websocket.close()


async def hosted() -> list[HostedAppSpec]:
    """Every app this machine serves now: one with a process that is up, or one somebody has open. Files Flowpad
    serves itself are always "up", so such an app is listed only while a page of it is open. A record that says
    up is not enough: nothing writes it when a process dies, so the process is asked (``readiness.serving``)."""
    from flow_sdk.core.webapp import readiness  # noqa: PLC0415
    from flow_sdk.schema.data_spec.webapp_lifecycle_spec import WebappLifecycleSpec  # noqa: PLC0415
    from flow_sdk.builtin import webapp_placement  # noqa: PLC0415
    from flow_sdk.builtin.faas.micro_app import WebApp  # noqa: PLC0415
    from flow_sdk.schema.data_spec.webapp_lifecycle_spec import SHOWABLE  # noqa: PLC0415
    from flow_sdk.schema.data_spec.webapp_spec import WEBAPP_KIND  # noqa: PLC0415

    showable = {state.value for state in SHOWABLE}
    ids = dict.fromkeys(_bare(p.webapp_id) for p in await webapp_placement.served_routes() if p.webapp_id)
    out: list[HostedAppSpec] = []
    for webapp_id in ids:
        try:
            app = await WebApp.get_by_id(webapp_id)
        except Exception:  # noqa: BLE001 — a route naming an app that is gone serves nothing
            app = None
        # An editor or a viewer (a sub-kind of ``application.web``) is a part of another screen, not an app
        # somebody opened: it is never listed.
        if app is None or str(app.kind or "").startswith(f"{WEBAPP_KIND}."):
            continue
        record = app.lifecycle
        if not record or record["state"] not in showable:
            continue
        connections = of(webapp_id)
        ports, pids = record.get("ports") or {}, record.get("pids") or {}
        if not ports and not connections:
            continue
        if ports and not await readiness.serving(app, WebappLifecycleSpec.model_validate(record)):
            continue
        out.append(HostedAppSpec(
            webapp_id=webapp_id,
            title=(getattr(app, "title", "") or "").strip() or app.name,
            project_id=app.project_id or "",
            state=record["state"],
            since=record.get("since"),
            port=ports.get("", next(iter(ports.values()), None)),
            pid=pids.get("", next(iter(pids.values()), None)),
            connections=connections,
        ))
    return sorted(out, key=lambda a: (-len(a.connections), a.title.lower()))


__all__ = ["HOSTED_ELEMENT", "RELAY_PATH", "add", "announce", "browser_family", "hold", "hold_for_port", "hosted",
           "move", "of", "remove", "script_tag", "served_at"]
