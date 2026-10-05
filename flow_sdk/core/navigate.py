"""Navigation as a call: show a place, and answer whether it can be used there.

Every way Flowpad is told to show something — ``flow navigate``, ``flow show``, an
agent's ``auto_open``, a ``navigate`` ComputeOp — goes through here and answers with
a ``NavigateResult``. Three stages, each with its own failure:

1. **Resolve** — does the address name something on this machine? A declared
   ``vfs/project-<id>/<path>`` is rebased onto the project's folder here; an unknown
   view, a missing entity or a missing file is ``NOT_FOUND``.
2. **Deliver** — to a session's display (``on_show``) or to a browser tab
   (a ``ui_command``). No browser open is ``NOT_YET``: nothing failed, nobody saw it.
3. **Probe** — is the target usable? Only what the backend can honestly judge:
   reachability and framing of a web page, the health of a service endpoint, the
   existence of a file. Each probe keeps its own budget (``HTTP_PROBE_TIMEOUT_S``);
   nothing here waits for the browser to acknowledge.

A target is delivered even when the probe says it is not usable yet, so the
person sees the tab and its state while a repair (a ``navigate`` op's agent rung)
runs; the re-navigate that follows a repair delivers it again, which is what makes
the display reload.
"""

from __future__ import annotations

import base64
import binascii
import logging
from pathlib import Path
from typing import TYPE_CHECKING, Any, Optional
from urllib.parse import quote, unquote, urlsplit

from flow_sdk.schema.data_spec.dock_pointer_spec import PROJECT_VFS, DockPointerSpec, tab_pointer_json
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode, NavigateResult

if TYPE_CHECKING:
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess

logger = logging.getLogger(__name__)

#: The origin a framing check is judged against. The display frames a page from
#: Flowpad's own origin, which is never the page's — so the honest question is
#: "may a FOREIGN origin frame this?", and a reserved, never-matching origin asks it
#: without depending on which port this instance's UI happens to be served from.
DISPLAY_EMBEDDER_ORIGIN = "http://flowpad.invalid"

#: ``encodeURIComponent``'s unescaped set — the TS pointer encoder's alphabet.
_URI_COMPONENT_SAFE = "-_.!~*'()"

#: A probe's ``nav_error`` → the display's verdict for it (``webapp-display/classify.ts``).
_NAV_VERDICT = {
    "connection_refused": "not_running",
    "dns_failure": "not_running",
    "timeout": "hung",
    "redirect_loop": "redirect_loop",
    "not_http": "not_http",
}

_LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1", "[::1]"}


# ── web-app url pointers ──────────────────────────────────────────────────────


def web_url_from_pointer(pointer: Optional[str]) -> Optional[str]:
    """The http(s) URL a ``web-app`` pointer ``url/<base64url>`` names, else ``None``.

    The Python twin of ``webUrlFromPointer`` (``ts_sdk/src/models/web-url-pointer.ts``):
    base64url of ``encodeURIComponent(href)``.
    """
    if not pointer or not pointer.startswith("url/"):
        return None
    encoded = pointer[4:].replace("-", "+").replace("_", "/")
    encoded += "=" * (-len(encoded) % 4)
    try:
        url = unquote(base64.b64decode(encoded, validate=True).decode("ascii"))
    except (binascii.Error, UnicodeDecodeError, ValueError):
        return None
    parts = urlsplit(url)
    return url if parts.scheme in ("http", "https") and parts.hostname else None


def pointer_for_web_url(url: str) -> str:
    """The ``web-app`` pointer for *url* — ``pointerForWebUrl``'s twin, for authoring."""
    encoded = base64.b64encode(quote(url, safe=_URI_COMPONENT_SAFE).encode("ascii")).decode("ascii")
    pointer = "url/" + encoded.replace("+", "-").replace("/", "_").rstrip("=")
    if web_url_from_pointer(pointer) is None:
        raise ValueError(f"{url!r} is not an http(s) URL")
    return pointer


# ── probes ────────────────────────────────────────────────────────────────────


def _is_loopback(url: str) -> bool:
    host = (urlsplit(url).hostname or "").lower()
    return host in _LOOPBACK_HOSTS or host.endswith(".localhost")


async def probe_web_url(url: str) -> tuple[ExitCode, Optional[str], str]:
    """``(exit_code, verdict, detail)`` for a web page shown in the display.

    An HTTP status counts only for a server on this machine: an external site is
    fetched without the person's cookies, so its 403/404 says nothing about what
    they will see (``flow_sdk/core/webpage_status.py``).
    """
    from flow_sdk.core.webpage_status import check_webpage_status  # noqa: PLC0415

    status = await check_webpage_status(url, DISPLAY_EMBEDDER_ORIGIN)
    host = urlsplit(url).netloc or url
    if status.frame_blocked:
        return ExitCode.REFUSED, "frame_blocked", f"{host} refuses to be shown inside Flowpad."
    if status.nav_error == "invalid_url":
        return ExitCode.NOT_FOUND, "not_found", f"{url} is not a web address."
    verdict = _NAV_VERDICT.get(status.nav_error or "")
    if verdict == "hung":
        return ExitCode.NOT_YET, verdict, f"{host} did not answer in time."
    if verdict is not None:
        return ExitCode.NOT_YET, verdict, f"Nothing is answering at {host}."
    if status.nav_error:  # the probe itself broke: say nothing we do not know
        return ExitCode.OK, None, ""
    if _is_loopback(url) and status.http_status is not None and status.http_status >= 500:
        return ExitCode.NOT_YET, "server_error", f"{host} answers with an error ({status.http_status})."
    return ExitCode.OK, "ok", ""


async def _probe_endpoint(endpoint_id: str) -> tuple[ExitCode, Optional[str], str]:
    """A service endpoint, probed where it runs — the same loopback request its
    ``probe`` action makes."""
    from flow_sdk.builtin.service_endpoint import ServiceEndpoint  # noqa: PLC0415
    from flow_sdk.core.webapp_probe import probe_webapp  # noqa: PLC0415

    endpoint = await ServiceEndpoint.get_by_id(endpoint_id)
    if endpoint is None:
        return ExitCode.NOT_FOUND, "not_found", f"No service endpoint {endpoint_id}."
    backend = endpoint.backend
    if getattr(backend, "type", None) != "proxy" or endpoint.remote:
        return ExitCode.OK, None, ""  # nothing on this machine to probe
    health = "/" + str(backend.health or "/").lstrip("/")
    found = await probe_webapp(f"http://127.0.0.1:{backend.port}{health}", backend.port)
    verdict = _NAV_VERDICT.get(found.get("nav_error") or "")
    if verdict is not None:
        return ExitCode.NOT_YET, verdict, f"Nothing is answering on port {backend.port}."
    status = found.get("http_status")
    if isinstance(status, int) and status >= 500:
        return ExitCode.NOT_YET, "server_error", f"The service answers with an error ({status})."
    return ExitCode.OK, "ok", ""


async def probe_target(view_type: str, pointer: str, path: Optional[Path]) -> tuple[ExitCode, Optional[str], str]:
    """Is the resolved target usable? ``(exit_code, verdict, detail)``."""
    if path is not None:
        if path.exists():
            return ExitCode.OK, "ok", ""
        return ExitCode.NOT_FOUND, "not_found", f"No file {path}."
    url = web_url_from_pointer(pointer) if view_type == "web-app" else None
    if url is not None:
        return await probe_web_url(url)
    if view_type == "app" and pointer.startswith("service_endpoint-"):
        return await _probe_endpoint(pointer.split("-", 1)[1].split("/", 1)[0])
    return ExitCode.OK, None, ""  # a screen or an entity view: resolving it was the check


# ── resolve ───────────────────────────────────────────────────────────────────


async def _project_file(project_id: str, rel: str) -> Path | str:
    """The local file a project-rooted pointer names, or why it cannot be found."""
    from flow_sdk.builtin.project import Project  # noqa: PLC0415

    try:
        project = await Project.get_by_id(project_id)
    except ValueError:  # not even an id — it names nothing here either
        project = None
    if project is None or not project.fs_storage_mount_path:
        return f"Project {project_id} is not on this machine."
    base = Path(project.fs_storage_mount_path).resolve()
    path = (base / rel).resolve()
    if not path.is_relative_to(base):
        return f"{rel} is outside the project."
    if not path.is_file():
        return f"No file {rel} in the project."
    return path


async def resolve_pointer(spec: DockPointerSpec) -> tuple[str, Optional[Path], dict[str, Any]] | NavigateResult:
    """``(tab pointer JSON, local file or None, display target)`` for *spec*, or the
    ``NOT_FOUND`` it ends in. A ``vfs/project-<id>/<rel>`` segment is rebased onto the
    project's folder: the form the editor renders, byte for byte the tab the UI writes."""
    from flow_sdk.api.api_types.vfs_path import VFSPath  # noqa: PLC0415
    from flow_sdk.builtin.agent_auto_open import LOCAL_COMPUTE_NODE  # noqa: PLC0415
    from flow_sdk.core.display_target import (  # noqa: PLC0415
        DisplayTargetNotFound,
        InvalidDisplayTarget,
        dock_target,
        resolve_display_target,
    )

    found = PROJECT_VFS.search(spec.pointer)
    if found is not None:
        path = await _project_file(found["project"], found["rel"])
        if isinstance(path, str):
            return NavigateResult.not_found(path, verdict="not_found", pointer=spec.to_json())
        local = VFSPath.from_machine_path(str(path), LOCAL_COMPUTE_NODE)
        pointer = f"{spec.pointer[:found.start()]}{found.group(1)}vfs/{local.abs_path}"
        return tab_pointer_json(spec.viewType, pointer), path, await resolve_display_target(path=str(path))
    try:
        target = await dock_target(f"{spec.viewType}/{spec.pointer}" if spec.pointer else spec.viewType)
    except (InvalidDisplayTarget, DisplayTargetNotFound) as exc:
        return NavigateResult.not_found(str(exc), verdict="not_found", pointer=spec.to_json())
    return spec.to_json(), None, target


# ── deliver ───────────────────────────────────────────────────────────────────


def pick_connection(connection_id: Optional[str]) -> tuple[str, Any] | NavigateResult:
    """The browser tab a ``ui_command`` goes to: the named one, else the active
    (most visible / focused) one. ``NOT_FOUND`` / ``NOT_YET`` when there is none."""
    from flow_sdk.server.routes.websocket import get_active_connection, get_connection_infos  # noqa: PLC0415

    if connection_id:
        info = get_connection_infos().get(connection_id)
        if info is None:
            return NavigateResult.not_found(f"No browser tab {connection_id} is open.", verdict="no_browser")
        return connection_id, info.ws
    active = get_active_connection()
    if active is None:
        return NavigateResult.not_yet("No Flowpad tab is open to show it in.", ran=False, verdict="no_browser")
    return active


async def _send_to_tab(connection: tuple[str, Any], target: dict[str, Any]) -> None:
    """One ``ui_command`` for a resolved display target — the listener's three forms."""
    from flow_sdk.core.display_target import DisplayTargetKind  # noqa: PLC0415
    from flow_sdk.notifications import send_ui_command  # noqa: PLC0415

    _, ws = connection
    kind = target.get("kind")
    if kind == DisplayTargetKind.ENTITY:
        await send_ui_command(ws, "navigate_entity", type=target["type"], id=target["id"])
    elif kind == DisplayTargetKind.VFS:
        await send_ui_command(ws, "navigate_vfs", path=target["path"])
    else:
        await send_ui_command(
            ws,
            "navigate_dock",
            view_type=target["view_type"],
            pointer=target.get("pointer"),
            options=target.get("options"),
            page=target.get("page"),
        )


async def deliver(
    pointer: str,
    target: dict[str, Any],
    *,
    process: Optional["AgenticProcess"] = None,
    connection_id: Optional[str] = None,
) -> NavigateResult:
    """Hand a resolved target to a session's display or a browser tab. ``OK`` when
    delivered, else why not; the target's health is ``probe_target``'s question."""
    if process is not None:
        await process.on_show(target)
        return NavigateResult.satisfied(pointer=pointer, delivered=True)
    connection = pick_connection(connection_id)
    if isinstance(connection, NavigateResult):
        return connection.model_copy(update={"pointer": pointer})
    await _send_to_tab(connection, target)
    return NavigateResult.satisfied(pointer=pointer, connection_id=connection[0], delivered=True)


def _verdict(delivered: NavigateResult, probed: tuple[ExitCode, Optional[str], str]) -> NavigateResult:
    """A delivery and a probe, as one answer: a failed delivery wins, then the probe."""
    if delivered.exit_code is not ExitCode.OK:
        return delivered
    code, verdict, detail = probed
    return delivered.model_copy(update={"exit_code": code, "verdict": verdict, "detail": detail})


# ── the call ──────────────────────────────────────────────────────────────────


async def navigate(
    spec: DockPointerSpec,
    *,
    process: Optional["AgenticProcess"] = None,
    connection_id: Optional[str] = None,
    probe: bool = True,
    show: bool = True,
) -> NavigateResult:
    """Show *spec* — in *process*'s display when given, else in a browser tab — and
    answer whether it can be used there. ``show=False`` only asks (resolve + probe):
    a status question must not move anybody's screen. Never raises for an outcome."""
    resolved = await resolve_pointer(spec)
    if isinstance(resolved, NavigateResult):
        return resolved
    pointer, path, target = resolved
    if show:
        delivered = await deliver(pointer, target, process=process, connection_id=connection_id)
    else:
        delivered = NavigateResult.satisfied(pointer=pointer, ran=False)
    probed = await probe_target(spec.viewType, spec.pointer, path) if probe else (ExitCode.OK, None, "")
    result = _verdict(delivered, probed)
    if not result.ok:
        logger.info("navigate %s → %s (%s) %s", pointer, result.exit_code.name, result.verdict, result.detail)
    return result


# ── a resolved display target (the routes and ``flow show``) ──────────────────


async def probe_display_target(target: dict[str, Any]) -> tuple[ExitCode, Optional[str], str]:
    """``probe_target`` for a display target as ``resolve_display_target`` returns it."""
    from flow_sdk.core.display_target import DisplayTargetKind  # noqa: PLC0415

    kind = target.get("kind")
    if kind == DisplayTargetKind.URL and target.get("url"):
        return await probe_web_url(str(target["url"]))
    if kind == DisplayTargetKind.VFS and target.get("path"):
        return await probe_target("", "", Path(str(target["path"])))
    if kind == DisplayTargetKind.APP and str(target.get("typeid") or "").startswith("service_endpoint-"):
        return await _probe_endpoint(str(target["typeid"]).split("-", 1)[1])
    if kind == DisplayTargetKind.DOCK:
        return await probe_target(str(target.get("view_type") or ""), str(target.get("pointer") or ""), None)
    return ExitCode.OK, None, ""  # an entity: resolving it was the check


async def show_target(
    target: dict[str, Any],
    *,
    process: Optional["AgenticProcess"] = None,
    connection_id: Optional[str] = None,
) -> NavigateResult:
    """Deliver an already-resolved display target and probe it — ``navigate`` for a
    caller that resolved the address itself (``flow show``, ``/agent/navigate/*``).
    The display target is the answer's ``value``."""
    pointer = ""
    if target.get("view_type"):
        pointer = tab_pointer_json(str(target["view_type"]), str(target.get("pointer") or ""))
    probed = await probe_display_target(target)
    if probed[0] is ExitCode.NOT_FOUND:
        # Nothing there is not worth a screen: answered before delivery, whoever is watching.
        return NavigateResult.not_found(probed[2], verdict=probed[1], pointer=pointer, value=target)
    delivered = await deliver(pointer, target, process=process, connection_id=connection_id)
    return _verdict(delivered, probed).model_copy(update={"value": target})
