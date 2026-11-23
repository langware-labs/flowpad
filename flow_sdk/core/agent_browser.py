"""A managed browser window: one per instance and browser driver, on a profile of Flowpad's own.

Every MANAGED browser driver (``agentic-assets/browser_driver/<name>/``, ``managed: true``) runs
through this module; its config (``browser_drivers.read_config``) says which app, which of
Flowpad's own profiles and which debugging port — none of the user's sign-ins, and the ones made
there are kept.

The default driver (``agent``) keeps ``~/.flow/instances/<instance>/browser/`` and the same files
as the real-browser skill's ``browser.mjs`` (``state.json``: ``{mode, browser, pid, port,
session}``), so the skill and a session's MCP server reuse one window. Any other driver has a
folder of its own under ``browser/drivers/<name>/``.

A session gets ONE MCP server whose command is this module (``python -m
flow_sdk.core.agent_browser mcp --driver <name>``): a small stdio proxy that answers
``initialize`` and ``tools/list`` itself (the tool list is cached per instance), and starts (or
reuses) the window only on the FIRST ``tools/call`` — then pipes everything to Playwright MCP
attached over CDP. A session that never browses never opens a window.
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

from flow_sdk.core import browser_drivers
from flow_sdk.core.app_ports import free_port
from flow_sdk.instances.paths import instance_dir
from flow_sdk.pid_probe import pid_is_alive
from flow_sdk.schema.data_spec.spec import DataSpec

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


def _driver_dir(instance: str | None = None, driver: str = browser_drivers.DEFAULT) -> Path:
    """The driver's own folder: the default driver keeps the shared ``browser/`` one."""
    base = _base_dir(instance)
    return base if driver == browser_drivers.DEFAULT else base / "drivers" / driver


def _profile_dir(base: Path, profile: str) -> Path:
    """A profile of Flowpad's own; ``default`` is the folder the window always used."""
    return base / "profile" if profile in ("", "default") else base / "profiles" / profile


def _state_path(instance: str | None = None, driver: str = browser_drivers.DEFAULT) -> Path:
    return _driver_dir(instance, driver) / "state.json"


def _read_state(instance: str | None = None, driver: str = browser_drivers.DEFAULT) -> dict:
    try:
        return json.loads(_state_path(instance, driver).read_text())
    except (OSError, ValueError):
        return {}


def _fixed_port(driver: str) -> Optional[int]:
    """The port the driver's config pins, or None when it takes a free one."""
    port = browser_drivers.read_config(driver).get("port") or ""
    return int(port) if port.isdigit() else None


def cdp_up(port: object) -> bool:
    if not isinstance(port, int):
        return False
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=1) as resp:
            return resp.status == 200
    except OSError:
        return False


def status(instance: str | None = None, driver: str = browser_drivers.DEFAULT) -> AgentBrowserStatus:
    """What is running now. Never starts anything."""
    state = _read_state(instance, driver)
    pid = state.get("pid") if isinstance(state.get("pid"), int) else None
    pinned = _fixed_port(driver)
    if pinned is not None:
        # A pinned port is the window whoever started it: a browser the person launched on it counts.
        up, port = cdp_up(pinned), pinned
        pid = pid if pid_is_alive(pid) else None
    else:
        ours = driver != browser_drivers.DEFAULT or state.get("mode") == "agent"
        up, port = bool(ours and pid_is_alive(pid) and cdp_up(state.get("port"))), state.get("port")
    return AgentBrowserStatus(
        up=up,
        pid=pid if up else None,
        port=port if up else None,
        browser=Path(state.get("browser") or "").name if up else "",
    )


def open_urls(instance: str | None = None) -> set[str]:
    """The addresses of the pages open in the agent browser now (no fragment); empty when it is not up."""
    port = status(instance).port
    if not port:
        return set()
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=1) as resp:
            tabs = json.loads(resp.read())
    except (OSError, ValueError):
        return set()
    return {str(tab.get("url") or "").split("#")[0] for tab in tabs if isinstance(tab, dict) and tab.get("type") == "page"}


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


def executable_for(driver: str = browser_drivers.DEFAULT) -> Optional[str]:
    """The program the driver's window runs: the app its config names, else the first of its
    ``apps`` installed here. None when none is."""
    from flow_sdk.core.browser_profiles import app_binary  # noqa: PLC0415

    spec = browser_drivers.get(driver)
    if spec is None:
        return None
    chosen = browser_drivers.read_config(driver).get("app") or ""
    if chosen:
        return app_binary(chosen)
    if driver == browser_drivers.DEFAULT and (found := find_browser()):
        return found
    return next((exe for exe in map(app_binary, spec.apps) if exe), None)


def ensure_running(instance: str | None = None, driver: str = browser_drivers.DEFAULT) -> AgentBrowserStatus:
    """Start the driver's window, or reuse the one running. Raises ``AgentBrowserError``."""
    current = status(instance, driver)
    if current.up:
        return current
    exe = executable_for(driver)
    if not exe:
        spec = browser_drivers.get(driver)
        wanted = browser_drivers.read_config(driver).get("app") or ", ".join(spec.apps if spec else ())
        raise AgentBrowserError(f"NO_BROWSER: none of these is installed: {wanted}")
    base = _driver_dir(instance, driver)
    profile = _profile_dir(base, browser_drivers.read_config(driver).get("profile") or "")
    profile.mkdir(parents=True, exist_ok=True)
    port = _fixed_port(driver) or free_port()
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
    state = _read_state(instance, driver)
    state.update({"mode": "agent", "browser": exe, "pid": child.pid, "port": port})
    _state_path(instance, driver).write_text(json.dumps(state, indent=2))
    return AgentBrowserStatus(up=True, pid=child.pid, port=port, browser=Path(exe).name)


def stop(instance: str | None = None, driver: str = browser_drivers.DEFAULT) -> bool:
    """Close the window THIS module started for the driver. False when there is none of ours:
    a browser the person launched on a pinned port is theirs to close."""
    pid = _read_state(instance, driver).get("pid")
    if not isinstance(pid, int) or not pid_is_alive(pid):
        return False
    try:
        os.kill(pid, 15)
    except OSError:
        return False
    return True


def mcp_spec(driver: str = browser_drivers.DEFAULT):
    """The driver's server for a session — its manifest's ``mcp``, run by this interpreter."""
    return browser_drivers.mcp_spec_for(driver)


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


def _start_playwright(init: dict, out, driver: str = browser_drivers.DEFAULT) -> subprocess.Popen:
    """The window (started or reused), then Playwright MCP on it, its replies piped to ``out``."""
    child = _spawn_playwright(ensure_running(driver=driver).port)
    _handshake(child, init)

    def pump() -> None:
        for line in child.stdout:
            out.write(line)
            out.flush()

    threading.Thread(target=pump, daemon=True).start()
    return child


def serve(inp, out, driver: str = browser_drivers.DEFAULT) -> None:
    """The lazy proxy: no window and no Playwright until the first ``tools/call``."""
    spec = browser_drivers.get(driver)
    server_name = spec.mcp.name if spec is not None and spec.mcp is not None else driver
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
                                 "serverInfo": {"name": server_name, "version": "1"}})
        elif method == "tools/call":
            try:
                child = _start_playwright(init, out, driver)
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


def _driver_arg(argv: list[str]) -> str:
    """``mcp [--driver NAME]`` — the default driver when none is named."""
    return argv[argv.index("--driver") + 1] if "--driver" in argv[:-1] else browser_drivers.DEFAULT


if __name__ == "__main__":
    serve(sys.stdin, sys.stdout, _driver_arg(sys.argv[1:]))
