"""The agent browser: Flowpad's own Chrome window, one per instance.

The user's installed Chrome (or Edge) on a profile of its own under
``~/.flow/instances/<instance>/browser/profile`` — none of the user's sign-ins, and
the ones made there are kept. Same files as the real-browser skill's ``browser.mjs``
(``state.json``: ``{mode, browser, pid, port, session}``), so the skill and a
session's ``browser`` MCP server reuse one window.

A session whose browser is ``agent`` gets ONE MCP server, ``browser``, whose command
is this module (``python -m flow_sdk.core.agent_browser``): a small stdio proxy that
answers ``initialize`` and ``tools/list`` itself (the tool list is cached per
instance), and starts (or reuses) the window only on the FIRST ``tools/call`` — then
pipes everything to Playwright MCP attached over CDP. A session that never browses
never opens a window.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
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


def _spawn_playwright(port: int) -> subprocess.Popen:
    npx = shutil.which("npx")
    if not npx:
        raise AgentBrowserError("NEEDS_SETUP: npx (Node.js) is not installed")
    return subprocess.Popen(
        [npx, "-y", PLAYWRIGHT_MCP, "--cdp-endpoint", f"http://127.0.0.1:{port}"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1,
    )


def _send(stream, msg: dict) -> None:
    stream.write(json.dumps(msg) + "\n")
    stream.flush()


def _reply(out, msg_id: object, result: dict) -> None:
    _send(out, {"jsonrpc": "2.0", "id": msg_id, "result": result})


def _error(out, msg_id: object, code: int, message: str) -> None:
    _send(out, {"jsonrpc": "2.0", "id": msg_id, "error": {"code": code, "message": message}})


def _await_reply(child: subprocess.Popen, msg_id: object) -> dict:
    for line in child.stdout:
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        if msg.get("id") == msg_id:
            return msg
    raise AgentBrowserError("PLAYWRIGHT_MCP_EXITED: Playwright MCP closed before answering")


def _handshake(child: subprocess.Popen, init: dict) -> None:
    _send(child.stdin, {**init, "id": "proxy-init"})
    _await_reply(child, "proxy-init")
    _send(child.stdin, {"jsonrpc": "2.0", "method": "notifications/initialized"})


def _tools(init: dict) -> list:
    """Playwright MCP's tool list, cached per instance. Probed against a port where
    nothing listens: Playwright MCP connects on a tool call, not on list, so no window."""
    cache = _base_dir() / "tools.json"
    try:
        cached = json.loads(cache.read_text())
        if cached.get("server") == PLAYWRIGHT_MCP:
            return cached["tools"]
    except (OSError, ValueError, KeyError):
        pass
    child = _spawn_playwright(free_port())
    try:
        _handshake(child, init)
        _send(child.stdin, {"jsonrpc": "2.0", "id": "probe-list", "method": "tools/list"})
        tools = _await_reply(child, "probe-list")["result"]["tools"]
    finally:
        child.kill()
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps({"server": PLAYWRIGHT_MCP, "tools": tools}))
    return tools


def _start_playwright(init: dict, out) -> subprocess.Popen:
    """The window (started or reused), then Playwright MCP on it, its replies piped to ``out``."""
    child = _spawn_playwright(ensure_running().port)
    _handshake(child, init)

    def pump() -> None:
        for line in child.stdout:
            out.write(line)
            out.flush()

    threading.Thread(target=pump, daemon=True).start()
    return child


def serve(inp, out) -> None:
    """The lazy proxy: no window and no Playwright until the first ``tools/call``."""
    init: dict = {"jsonrpc": "2.0", "method": "initialize", "params": {}}
    child: Optional[subprocess.Popen] = None
    for line in inp:
        if child is not None:
            child.stdin.write(line)
            child.stdin.flush()
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        method, msg_id = msg.get("method"), msg.get("id")
        if method == "initialize":
            init = {k: v for k, v in msg.items() if k != "id"}
            version = (msg.get("params") or {}).get("protocolVersion", "2025-03-26")
            _reply(out, msg_id, {"protocolVersion": version, "capabilities": {"tools": {}},
                                 "serverInfo": {"name": MCP_NAME, "version": "1"}})
        elif method == "tools/call":
            try:
                child = _start_playwright(init, out)
            except (AgentBrowserError, OSError) as exc:
                _reply(out, msg_id, {"isError": True, "content": [{"type": "text", "text": str(exc)}]})
                continue
            child.stdin.write(line)
            child.stdin.flush()
        elif msg_id is None:
            continue  # a notification before the first call
        elif method == "tools/list":
            try:
                _reply(out, msg_id, {"tools": _tools(init)})
            except (AgentBrowserError, OSError) as exc:
                _error(out, msg_id, -32603, str(exc))
        elif method == "ping":
            _reply(out, msg_id, {})
        else:
            _error(out, msg_id, -32601, f"{method} not supported")
    if child is not None:
        child.stdin.close()
        child.wait()


if __name__ == "__main__":
    serve(sys.stdin, sys.stdout)
