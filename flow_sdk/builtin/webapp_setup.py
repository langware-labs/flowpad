"""A web app's setup steps, run in this backend: install → build → start, each with its own check.

The setup tree's web-app node calls these through ``CliOp.webapp_step`` (the way a data source's steps
run through ``source_step``): no process, no shell, no HTTP call back into this backend. ``flow app open``
did the same work by guessing from a checkout; here the app's ``webapp.json`` says what it needs
(``serving.install_cmd`` / ``build_cmd`` / ``start_cmd`` / ``health`` / ``port``), and what it does not say
is derived the same way (``npm ci`` when there is a lockfile).

**Ours, or not.** A port answering is not proof the APP answers: another program (a container, a
second checkout) may sit on it. "Running" means the port this app's own endpoint records answers its
``health`` path — and a start never adopts a port somebody else holds: a fixed one is reported busy, a
picked one moves on to a free port.
"""

from __future__ import annotations

import asyncio
import logging
import subprocess
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Optional

from flow_sdk.schema.data_spec.returned_value_spec import ExitCode, ReturnedValue

logger = logging.getLogger(__name__)

#: How long a started server gets to answer. The start command's own warm-up (a dev bundler) — not a
#: budget a slow app should be given more of to look healthy: an app that needs longer is a finding.
START_SECONDS = 60.0
#: A single health probe. Local and loopback: anything slower is not answering.
PROBE_SECONDS = 2.0
#: An install's own budget (``npm ci`` on a cold cache), the same the CLI's install used.
INSTALL_SECONDS = 300.0

STEPS = ("install", "build", "start")


def _answer(code: ExitCode, detail: str, *, ran: bool = True, value: Any = None) -> ReturnedValue:
    return ReturnedValue(exit_code=code, detail=detail, ran=ran, value=value)


def health_answers(port: int, path: str = "/") -> bool:
    """The app's own health path answers below 500 on ``port`` (a redirect or a 404 page is still a server).

    Asked on each loopback (``dev_server.LOOPBACKS``): a Vite or Next server on ``localhost`` listens on
    ``::1`` alone, a uvicorn on ``127.0.0.1`` alone."""
    from flow_sdk.core.dev_server import LOOPBACKS  # noqa: PLC0415

    rel = path if path.startswith("/") else "/" + path
    for host in LOOPBACKS:
        url = f"http://{'[' + host + ']' if ':' in host else host}:{int(port)}{rel}"
        try:
            with urllib.request.urlopen(url, timeout=PROBE_SECONDS) as response:  # noqa: S310 — loopback only
                return response.status < 500
        except urllib.error.HTTPError as error:
            return error.code < 500
        except (urllib.error.URLError, OSError, ValueError):
            continue
    return False


async def _app(webapp_id: str):
    from flow_sdk.builtin.faas.micro_app import WebApp  # noqa: PLC0415

    bare = webapp_id.split("-", 1)[1] if webapp_id.startswith("micro_app-") else webapp_id
    return await WebApp.get_by_id(bare)


def _proxy(app) -> Optional[tuple[str, Any]]:
    """``(endpoint name, spec)`` of the app's dev server, or None for an app that is only files."""
    from flow_sdk.builtin.webapp_placement import _app_specs  # noqa: PLC0415

    return next(((name, spec) for name, spec in _app_specs(app) if spec.serving.type == "proxy"), None)


def _run(command: str, folder: Path, log_name: str, seconds: float) -> tuple[int, str]:
    """Run ``command`` in ``folder``, its output to a log; ``(exit code, last lines)``."""
    from flow_sdk.core.dev_server import log_dir  # noqa: PLC0415

    logs = log_dir()
    logs.mkdir(parents=True, exist_ok=True)
    log_file = logs / f"{log_name}.log"
    try:
        with log_file.open("ab") as log:
            done = subprocess.run(  # noqa: S602 — the app author's own install/build command
                command, cwd=str(folder), shell=True, stdin=subprocess.DEVNULL, stdout=log,
                stderr=subprocess.STDOUT, timeout=seconds, check=False,
            )
        code = done.returncode
    except subprocess.TimeoutExpired:
        code = 124
    tail = "\n".join(log_file.read_text(errors="replace").splitlines()[-8:])
    return code, f"{tail}\n(log: {log_file})"


async def _endpoint(app, name: str):
    from flow_sdk.builtin.webapp_placement import webapp_endpoints  # noqa: PLC0415

    return next((e for e in await webapp_endpoints(app.id) if e.name == name and e.backend.type == "proxy"), None)


async def step(webapp_id: str, which: str, *, check: bool) -> ReturnedValue:
    """One of the app's setup steps (``install`` / ``build`` / ``start``). ``check`` judges what is ON THIS
    MACHINE now and changes nothing. Never raises for an outcome."""
    app = await _app(webapp_id)
    if app is None or not app.asset_ref:
        return _answer(ExitCode.NOT_FOUND, f"there is no web app {webapp_id!r} here", ran=False)
    if which not in STEPS:
        return _answer(ExitCode.NOT_FOUND, f"a web app has no setup step {which!r} (it has {', '.join(STEPS)})", ran=False)
    folder = Path(app.asset_ref)
    proxy = _proxy(app)
    if proxy is None:
        return _answer(ExitCode.OK, f"{app.name} is files Flowpad serves itself", ran=False)
    name, spec = proxy
    serving = spec.serving
    if which == "install":
        return await _install(app, folder, serving, check=check)
    if which == "build":
        return await _build(app, folder, serving, check=check)
    return await _start(app, folder, name, serving, check=check)


async def _install(app, folder: Path, serving, *, check: bool) -> ReturnedValue:
    from flow_sdk.core.dev_server import install_command  # noqa: PLC0415

    declared = serving.install_cmd
    if not declared and not (folder / "package.json").exists():
        return _answer(ExitCode.OK, "nothing to install", ran=False)
    if not declared and (folder / "node_modules").is_dir():
        return _answer(ExitCode.OK, "dependencies are installed", ran=False)
    if check:
        # A declared install has no marker of its own: it is judged by its result, the start.
        return _answer(ExitCode.NOT_YET, "dependencies are not installed", ran=False)
    command = declared or install_command(serving.start_cmd, folder)
    return await _run_step(command, folder, f"install-{app.name}", done=f"installed with `{command}`")


async def _build(app, folder: Path, serving, *, check: bool) -> ReturnedValue:
    command = serving.build_cmd
    if not command:
        return _answer(ExitCode.OK, "no build step", ran=False)
    built = folder / (app.build if app.build not in ("", ".") else "dist")
    if built.is_dir() and any(built.iterdir()):
        return _answer(ExitCode.OK, f"built into {built.name}/", ran=False)
    if check:
        return _answer(ExitCode.NOT_YET, "not built yet", ran=False)
    return await _run_step(command, folder, f"build-{app.name}", done=f"built with `{command}`")


async def _run_step(command: str, folder: Path, log_name: str, *, done: str) -> ReturnedValue:
    """Run an install/build command off the loop; its failure carries the command, its exit and its last lines."""
    code, tail = await asyncio.to_thread(_run, command, folder, log_name, INSTALL_SECONDS)
    if code != 0:
        return _answer(ExitCode.NOT_YET, f"`{command}` failed (exit {code}):\n{tail}")
    return _answer(ExitCode.OK, done)


async def _start(app, folder: Path, name: str, serving, *, check: bool) -> ReturnedValue:
    from flow_sdk.core import dev_server  # noqa: PLC0415

    existing = await _endpoint(app, name)
    held = existing.backend.port if existing is not None else None
    if held and await asyncio.to_thread(health_answers, held, serving.health):
        return _answer(ExitCode.OK, f"running at http://127.0.0.1:{held}", ran=False, value=str(held))
    if check:
        return _answer(ExitCode.NOT_YET, f"{app.name} is not running", ran=False)

    port = serving.port or held
    if port and await asyncio.to_thread(dev_server.port_open, port):
        if serving.port:
            return _answer(
                ExitCode.NOT_YET,
                f"port {port} is held by another program, and {app.name} can only run on that port — "
                "stop what holds it, then set up again",
            )
        port = None  # a port we picked before, taken since: pick again
    port = port or await asyncio.to_thread(dev_server.find_free_port)
    command = serving.start_cmd.replace("{port}", str(port))
    pid, log_file = await asyncio.to_thread(dev_server.start_detached, command, cwd=folder, port=port, name=app.name)
    if not await asyncio.to_thread(dev_server.wait_for_port, port, START_SECONDS):
        return _answer(ExitCode.NOT_YET, f"`{command}` started (pid {pid}) but port {port} never opened — log: {log_file}")
    if not await asyncio.to_thread(health_answers, port, serving.health):
        return _answer(ExitCode.NOT_YET, f"{app.name} opened port {port} but {serving.health} does not answer — log: {log_file}")
    await _keep_endpoint(app, name, port, command, serving.health, existing)
    return _answer(ExitCode.OK, f"running at http://127.0.0.1:{port}", value=str(port))


async def _keep_endpoint(app, name: str, port: int, command: str, health: str, existing) -> None:
    """The app's proxy endpoint on its project's local placement now names this port."""
    from flow_sdk.builtin.project import Project  # noqa: PLC0415
    from flow_sdk.builtin.webapp_placement import local_web_deployment, tell_hub, upsert_endpoint  # noqa: PLC0415

    project = await Project.get_by_id(app.project_id) if app.project_id else None
    deployment = await local_web_deployment(project)
    if deployment is None:
        return
    _row, saved = await upsert_endpoint(
        deployment, existing=existing, name=name, webapp_id=app.id, project_id=app.project_id or None,
        backend={"type": "proxy", "port": port, "start_cmd": command, "health": health},
        # A dev server on this machine is loaded at its own address (HMR and absolute paths need that) — as
        # ``register_dev_endpoint`` registers one.
        supports_direct_access=True,
    )
    if saved:
        tell_hub(deployment)
