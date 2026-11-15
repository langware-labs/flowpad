"""The agent browser: Flowpad's own Chrome window, one per instance.

The user's installed Chrome (or Edge) on a profile of its own under
``~/.flow/instances/<instance>/browser/profile`` — none of the user's sign-ins, and
the ones made there are kept. Same files as the real-browser skill's ``browser.mjs``
(``state.json``: ``{mode, browser, pid, port, session}``), so the skill and a
session's ``browser`` MCP server reuse one window.

A session whose browser is ``agent`` gets ONE MCP server, ``browser``, whose command
is this module (``python -m flow_sdk.core.agent_browser``): it starts (or reuses) the
window, then execs Playwright MCP attached to it over CDP. Starting it there, not at
spawn, keeps the launch path free of a browser start.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from typing import Optional

from flow_sdk.core.app_ports import free_port
from flow_sdk.instances.paths import instance_dir
from flow_sdk.pid_probe import pid_is_alive
from flow_sdk.schema.data_spec.spec import DataSpec

#: The MCP server's name in a session — its tools are ``mcp__agent_browser__*``. Not
#: ``browser``: Copilot's model API reserves that namespace and refuses the whole turn.
MCP_NAME = "agent_browser"
PLAYWRIGHT_MCP = "@playwright/mcp@latest"


class AgentBrowserStatus(DataSpec):
    up: bool = False
    pid: Optional[int] = None
    port: Optional[int] = None
    browser: str = ""


def _instance() -> str:
    return os.environ.get("FLOW_INSTANCE") or "prod"


def _base_dir(instance: str | None = None) -> Path:
    return instance_dir(instance or _instance()) / "browser"


def _state_path(instance: str | None = None) -> Path:
    return _base_dir(instance) / "state.json"


def _read_state(instance: str | None = None) -> dict:
    try:
        return json.loads(_state_path(instance).read_text())
    except (OSError, ValueError):
        return {}


def cdp_up(port: object) -> bool:
    if not isinstance(port, int):
        return False
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=1) as resp:
            return resp.status == 200
    except OSError:
        return False


def status(instance: str | None = None) -> AgentBrowserStatus:
    """What is running now. Never starts anything."""
    state = _read_state(instance)
    pid = state.get("pid") if isinstance(state.get("pid"), int) else None
    up = state.get("mode") == "agent" and pid_is_alive(pid) and cdp_up(state.get("port"))
    return AgentBrowserStatus(
        up=up,
        pid=state.get("pid") if up else None,
        port=state.get("port") if up else None,
        browser=Path(state.get("browser") or "").name if up else "",
    )


def find_browser() -> Optional[str]:
    """The user's installed Chrome, else Edge — the order ``browser.mjs`` uses."""
    candidates = [os.environ.get("CHROME_BIN")]
    if sys.platform == "darwin":
        candidates += [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            str(Path.home() / "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ]
    elif sys.platform == "win32":
        for root in filter(None, (os.environ.get(k) for k in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"))):
            candidates += [
                str(Path(root, "Google", "Chrome", "Application", "chrome.exe")),
                str(Path(root, "Microsoft", "Edge", "Application", "msedge.exe")),
            ]
    else:
        candidates += [shutil.which(n) for n in ("google-chrome", "google-chrome-stable", "chromium", "microsoft-edge")]
    return next((c for c in candidates if c and Path(c).exists()), None)


class AgentBrowserError(RuntimeError):
    pass


def ensure_running(instance: str | None = None) -> AgentBrowserStatus:
    """Start the window, or reuse the one running. Raises ``AgentBrowserError``."""
    current = status(instance)
    if current.up:
        return current
    exe = find_browser()
    if not exe:
        raise AgentBrowserError("NO_BROWSER: neither Chrome nor Edge is installed")
    base = _base_dir(instance)
    profile = base / "profile"
    profile.mkdir(parents=True, exist_ok=True)
    port = free_port()
    with open(base / "browser.log", "w") as log:
        child = subprocess.Popen(
            [exe, f"--remote-debugging-port={port}", f"--user-data-dir={profile}",
             "--no-first-run", "--no-default-browser-check", "about:blank"],
            stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True,
        )
    # Chrome answers CDP within a second or two; 15s matches browser.mjs (75 × 200ms).
    up = False
    for _ in range(75):
        up = cdp_up(port)
        if up or child.poll() is not None:
            break
        time.sleep(0.2)
    if not up:
        raise AgentBrowserError(f"BROWSER_DID_NOT_START: the agent profile may be open elsewhere ({profile})")
    state = _read_state(instance)
    state.update({"mode": "agent", "browser": exe, "pid": child.pid, "port": port})
    _state_path(instance).write_text(json.dumps(state, indent=2))
    return AgentBrowserStatus(up=True, pid=child.pid, port=port, browser=Path(exe).name)


def mcp_spec():
    """The session's ``browser`` server: this module, run by this interpreter."""
    from flow_sdk.schema.data_spec.mcp_spec import McpSpec  # noqa: PLC0415

    return McpSpec(name=MCP_NAME, command=sys.executable, args=["-m", "flow_sdk.core.agent_browser", "mcp"])


def _serve_mcp() -> None:
    try:
        running = ensure_running()
    except AgentBrowserError as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(2)
    npx = shutil.which("npx")
    if not npx:
        print("NEEDS_SETUP: npx (Node.js) is not installed", file=sys.stderr)
        sys.exit(8)
    os.execv(npx, [npx, "-y", PLAYWRIGHT_MCP, "--cdp-endpoint", f"http://127.0.0.1:{running.port}"])


if __name__ == "__main__":
    _serve_mcp()
