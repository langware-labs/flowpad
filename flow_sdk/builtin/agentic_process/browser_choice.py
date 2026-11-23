"""Which browser a session uses — one rule, read at every launch.

Most specific first:

==========  ==================================================================================
``session`` the session's own: ``context_data["browser"]`` — what its launch asked for (a message
            channel names its browser this way), what ``flow browser select`` set, or what the
            first launch decided and kept (:func:`keep_choice`); then the legacy ``chrome`` flag
``pick``    the project default on THIS computer (:func:`set_browser_pick`, ``flow browser default``)
``project`` the ``browser`` the project recommends in ``project_manifest.json``
``default`` ``agent``
==========  ==================================================================================

A choice holds a browser driver's name (``agentic-assets/browser_driver/<name>/``) or a browser
kind (``<browser>.<driving>.name.<profile>`` — one profile of it); ``browser_drivers.driver_of``
reads the driver off either. The manifest names the workers a driver supports: a choice the
session's worker cannot use falls to the default driver, and the answer keeps what was asked
(``requested``) so a menu can say why.
"""

from __future__ import annotations

import functools
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any, Optional

from flow_sdk.core import browser_drivers
from flow_sdk.schema.data_spec.browser_driver_spec import BrowserAttach
from flow_sdk.schema.data_spec.spec import DataSpec

if TYPE_CHECKING:
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess

#: The person's pick per project, on this computer only: ``{<project id>: <browser driver name>}``.
PREF_BROWSER_PICK = "preferences.browser.pick"


class BrowserLaunch(DataSpec):
    """The session's browser for one launch, decided at the agentic-process level. Each worker
    renders it with its own CLI switches (``AgentOptions.EXTENSION_FLAG`` / ``STRICT_MCP_FLAG``)."""

    #: A browser driver's name.
    kind: str = browser_drivers.DEFAULT
    #: The choice as it was made — a browser kind when one profile was chosen, else the driver's name.
    chosen: str = ""
    #: Which rung decided: ``pick`` | ``session`` | ``project`` | ``default``.
    source: str = "default"
    #: The session's worker, by vendor key — a driver reaches each worker its own way.
    worker: str = ""
    #: The driver that was asked for but cannot serve this worker; "" when the choice stood.
    requested: str = ""

    @property
    def attach(self) -> Optional[BrowserAttach]:
        return browser_drivers.attach_for(self.kind, self.worker)

    @property
    def extension(self) -> bool:
        """The worker's own browser switch carries this launch."""
        return self.attach is BrowserAttach.HARNESS_EXTENSION

    def mcp_spec(self):
        """The MCP server this launch adds to the session, or None when it rides the worker's switch."""
        return browser_drivers.mcp_spec_for(self.kind) if self.attach is BrowserAttach.MCP_SERVER else None

    def instructions(self) -> str:
        """What the session is told about its browser — the driver's own text."""
        return browser_drivers.instructions_for(self.kind)


#: Browser tools a session may carry that are no driver of ours, by tool-name prefix.
_OTHER_TOOLS = {
    "mcp__playwright__": "playwright",
    "mcp__debugMcp__": "playwright",
    "mcp__chrome-devtools__": "playwright",
}


def _family(tool_name: str) -> Optional[str]:
    """Which browser a tool call drove: a driver's name, ``playwright`` for another one, else None."""
    return browser_drivers.family_of(tool_name) or next((f for p, f in _OTHER_TOOLS.items() if tool_name.startswith(p)), None)


def decide(
    *, override: object, legacy_chrome: bool, project_browser: str, worker: str = "", has_switch: bool = False,
    pick: object = None,
) -> BrowserLaunch:
    """The pure rule — see the module docstring. ``worker``: the session's vendor key;
    ``has_switch``: that worker has a browser switch of its own."""
    extension = next((name for name in browser_drivers.names() if browser_drivers.uses_switch(name)), "")
    asked = (
        (override, "session"),
        (extension if legacy_chrome else None, "session"),
        (pick, "pick"),
        # The manifest is silent on the default, so the default there is no recommendation.
        (project_browser if project_browser != browser_drivers.DEFAULT else None, "project"),
    )
    chosen, kind, source = next(
        ((str(name), driver, rung) for name, rung in asked if (driver := browser_drivers.driver_of(name))),
        (browser_drivers.DEFAULT, browser_drivers.DEFAULT, "default"),
    )
    if not browser_drivers.supports(kind, worker, has_switch=has_switch):
        return BrowserLaunch(worker=worker, requested=kind)
    return BrowserLaunch(kind=kind, chosen=chosen, source=source, worker=worker)


def resolve(**asked: Any) -> str:
    """:func:`decide`, answering the driver's name alone."""
    return decide(**asked).kind


def browser_pick(project_id: Any) -> str:
    """The project default on this computer: a browser driver's name or a browser kind, or ""."""
    from flow_sdk.preferences import read_project_pick  # noqa: PLC0415

    return read_project_pick(PREF_BROWSER_PICK, project_id)


def set_browser_pick(project_id: Any, name: str) -> None:
    """Set the project default on this computer; "" clears it. ``ValueError`` for an unknown browser."""
    from flow_sdk.preferences import write_project_pick  # noqa: PLC0415

    write_project_pick(PREF_BROWSER_PICK, project_id, known_browser(name))


def known_browser(name: object) -> str:
    """``name`` when it is "" or names a driver or one of its kinds. ``ValueError`` otherwise."""
    value = str(name or "").strip()
    if value and not browser_drivers.driver_of(value):
        raise ValueError(f"browser {value!r} is not a browser kind or one of {', '.join(browser_drivers.names())}")
    return value


def keep_choice(process: "AgenticProcess", browser: str) -> bool:
    """Make ``browser`` the session's own (``context_data["browser"]``), which later launches read
    first; "" gives the choice back to the project. True when it changed. The caller saves."""
    data = dict(process.context_data or {})
    if (data.get("browser") or "") == browser:
        return False
    if browser:
        data["browser"] = browser
    else:
        data.pop("browser", None)
    process.context_data = data
    return True


@functools.lru_cache(maxsize=None)
def _options_class(driver_cls: type) -> type:
    method = driver_cls.cli_options
    hint = method.__annotations__["return"]  # a name under ``from __future__ import annotations``
    return getattr(sys.modules[method.__module__], hint) if isinstance(hint, str) else hint


def worker_options(worker_type: str | None) -> type:
    """The options CLASS a worker type launches with — where its browser switches are declared
    (class constants), read off its driver's ``cli_options`` return type: nothing is built."""
    from flow_sdk.builtin.agentic_process.cli_drivers import get_driver  # noqa: PLC0415

    return _options_class(type(get_driver(worker_type)))


def has_switch(worker_type: object) -> bool:
    """The worker has a browser switch of its own (Claude: ``--chrome``) — what a
    ``harness_extension`` driver rides."""
    return worker_options(worker_type).EXTENSION_FLAG is not None  # type: ignore[arg-type]


def worker_key(worker_type: object) -> str:
    """A worker type as the vendor key a browser driver's ``workers`` names; "" when unknown."""
    from flow_sdk.flowpad_types.vendors import vendor_or_none  # noqa: PLC0415

    vendor = vendor_or_none(worker_type)
    return vendor.key if vendor is not None else ""


async def resolve_for(process: "AgenticProcess", project_browser: Optional[str] = None) -> BrowserLaunch:
    """``project_browser``: the project's recommendation when the caller already read it."""
    if project_browser is None:
        from flow_sdk.assets.project_manifest import read_browser  # noqa: PLC0415
        from flow_sdk.builtin.project import Project  # noqa: PLC0415

        project = await Project.get_by_id(process.project_id) if process.project_id else None
        mount = project.fs_storage_mount_path if project is not None else None
        root = mount or process.workdir
        project_browser = read_browser(Path(root)) if root else browser_drivers.DEFAULT
    return decide(
        pick=browser_pick(process.project_id),
        override=(process.context_data or {}).get("browser"),
        legacy_chrome=bool((process.cli_config or {}).get("chrome")),
        project_browser=project_browser,
        worker=worker_key(process.worker_type),
        has_switch=has_switch(process.worker_type),
    )


def machine_view(
    worker_type: object, *, in_use: str = "", chosen: str = "", last_use: Optional[dict] = None,
) -> tuple[dict, list[dict], list[dict]]:
    """What this machine offers a session of ``worker_type``: the worker's extension facts, every
    driver with its state, and the browser kinds (one per profile). Reads files and probes ports;
    starts nothing. ``in_use``: the driver the session has; ``chosen``: its choice as it was made
    (a kind, when one profile was chosen); ``last_use``: its last browser call."""
    worker, switch = worker_key(worker_type), has_switch(worker_type)
    # Extension facts only for a worker that has one.
    extension: dict = {"installed": False, "device": ""}
    scan = None
    if extension_id := worker_options(worker_type).EXTENSION_ID:
        from flow_sdk.core.browser_profiles import scan_extension  # noqa: PLC0415

        scan = scan_extension(extension_id)
        extension = {
            **extension_hint(),
            "profiles": [{**p.profile.model_dump(), "browser": p.browser, "installed": p.installed} for p in scan.profiles],
            "profiles_denied": scan.denied,
        }
    drivers = []
    for spec in browser_drivers.list_drivers():
        setup = browser_drivers.worker_setup(spec.name, worker)
        drivers.append({
            **spec.model_dump(mode="json"),
            # One word a menu shows, read here so no client re-derives it.
            "state": browser_drivers.state_of(
                spec.name, worker, has_switch=switch, extension_installed=bool(extension.get("installed")),
                in_use=spec.name == in_use, last_use=last_use),
            "setup": setup.setup if setup is not None else "",
            "config": browser_drivers.read_config(spec.name),
        })
    # The session's last call on its own browser worked: a failure reported before it is over.
    worked = last_use is not None and last_use.get("family") == in_use and not last_use.get("failed")
    proven = (chosen or in_use, str(last_use.get("at") or "")) if worked and last_use else ("", "")
    kinds = browser_drivers.list_kinds({driver["name"]: driver["state"] for driver in drivers}, scan, proven)
    return extension, drivers, [kind.model_dump(mode="json") for kind in kinds]


def extension_hint() -> dict:
    """What Claude Code last recorded about the extension (``~/.claude.json``). A hint:
    the live answer is only known inside a session, on its next browser call."""
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    try:
        data = json.loads((get_instance_settings().user_home / ".claude.json").read_text())
    except (OSError, ValueError):
        return {"installed": False, "device": ""}
    return {
        "installed": bool(data.get("cachedChromeExtensionInstalled")),
        "device": str((data.get("chromeExtension") or {}).get("pairedDeviceName") or ""),
    }


def _use(family: str, tool: str, args: object, at: object, failed: bool) -> dict:
    url = args.get("url", "") if isinstance(args, dict) else ""
    return {"family": family, "tool": tool, "url": url or "", "at": at, "failed": failed}


def _iso(at: object) -> object:
    """A record's clock as ISO text: epoch milliseconds (OpenCode) become what the others write."""
    return datetime.fromtimestamp(at / 1000, tz=timezone.utc).isoformat() if isinstance(at, (int, float)) else at


def last_browser_use(transcript: Optional[Path], tail_bytes: int = 400_000, *, unnamed: str = "") -> Optional[dict]:
    """The session's last browser tool call: ``{family, tool, url, at, failed}``. Reads the
    transcript's tail only — a session's last call is near its end.

    ``unnamed``: the session's own browser driver, credited for a ``browser_*`` call a worker
    records with no server name (Deep Agents)."""
    if transcript is None or not transcript.exists():
        return None
    with transcript.open("rb") as fh:
        fh.seek(max(0, transcript.stat().st_size - tail_bytes))
        lines = fh.read().decode("utf-8", "replace").splitlines()
    pending: dict[str, dict] = {}
    last: Optional[dict] = None
    for line in lines:
        try:
            row = json.loads(line)
        except ValueError:
            continue
        item = row.get("item")
        if isinstance(item, dict) and item.get("type") == "mcp_tool_call":
            # A finished call with server and tool apart (the Codex stream).
            family = _family(f"mcp__{item.get('server')}__")
            if family:
                failed = bool(item.get("error")) or item.get("status") == "failed"
                last = _use(family, str(item.get("tool") or ""), item.get("arguments"), row.get("timestamp"), failed)
            continue
        part = row.get("part")
        if row.get("type") == "tool_use" and isinstance(part, dict) and part.get("type") == "tool":
            # OpenCode: one finished call, the tool named ``<server>_<tool>``.
            family, state = _family(str(part.get("tool") or "")), part.get("state") or {}
            if family:
                last = _use(family, str(part["tool"]), state.get("input"), _iso(row.get("timestamp")), state.get("status") == "error")
            continue
        if row.get("type") in ("tool_call", "tool_result") and "tool_call_id" in row:
            # Deep Agents: a call names the bare tool, its result carries the outcome.
            name, call_id = str(row.get("name") or ""), row["tool_call_id"]
            if row["type"] == "tool_call":
                family = _family(name) or (unnamed if name.startswith("browser_") else None)
                if family:
                    last = _use(family, name, row.get("input"), row.get("timestamp"), False)
                    pending[call_id] = last
            elif call_id in pending:
                pending.pop(call_id)["failed"] = bool(row.get("is_error"))
            continue
        data = row.get("data")
        if isinstance(data, dict) and row.get("type") in ("tool.execution_start", "tool.execution_complete"):
            # Copilot: a start names the server and tool, its complete carries the outcome.
            call_id = data.get("toolCallId", "")
            if row["type"] == "tool.execution_start":
                family = _family(f"mcp__{data.get('mcpServerName')}__")
                if family:
                    last = _use(family, str(data.get("mcpToolName") or ""), data.get("arguments"), row.get("timestamp"), False)
                    pending[call_id] = last
            elif call_id in pending:
                pending.pop(call_id)["failed"] = not data.get("success", True)
            continue
        content = (row.get("message") or {}).get("content")
        for block in content if isinstance(content, list) else ():
            if not isinstance(block, dict):
                continue
            if block.get("type") == "tool_use":
                name = str(block.get("name") or "")
                family = _family(name)
                if family:
                    last = _use(family, name.rsplit("__", 1)[-1], block.get("input"), row.get("timestamp"), False)
                    pending[block.get("id", "")] = last
            elif block.get("type") == "tool_result" and block.get("tool_use_id") in pending:
                pending.pop(block["tool_use_id"])["failed"] = bool(block.get("is_error"))
    if last is not None and not last["at"]:
        # A record with no clock: the transcript's own write time stands in.
        last["at"] = datetime.fromtimestamp(transcript.stat().st_mtime, tz=timezone.utc).isoformat()
    return last
