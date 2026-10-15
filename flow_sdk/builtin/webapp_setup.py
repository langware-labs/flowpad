"""A web app's setup steps, run in this backend: install → build → start, each with its own check.

The setup tree's web-app node calls these through ``CliOp.webapp_step`` (the way a data source's steps
run through ``source_step``): no process, no shell, no HTTP call back into this backend. ``flow app open``
did the same work by guessing from a checkout; here the app's ``webapp.json`` says what it needs
(``serving.install_cmd`` / ``build_cmd`` / ``start_cmd`` / ``health`` / ``port``), and what it does not say
is derived the same way (``npm ci`` when there is a lockfile).

**Ours, or not.** A port answering is not proof the APP answers: another program (a container, a
second checkout) may sit on it. Which port a process runs on, and whether what holds it is this app, is
decided in one place — ``flow_sdk/core/app_ports.py`` — from what ``webapp.json`` declares
(``serving.ports``) and what the process table shows now. Nothing is remembered: a server that died,
moved, or was started by hand is read as what it is. A start never adopts a port somebody else holds;
a start that fails kills what it launched, and a crash is reported when it happens, not when the wait
runs out.
"""

from __future__ import annotations

import asyncio
import logging
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

from flow_sdk.core import app_ports
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode, ReturnedValue
from flow_sdk.stream_inbox._locks import keyed_loop_lock, new_registry

logger = logging.getLogger(__name__)
_START_LOCKS = new_registry()

#: How long a started server gets to answer. The start command's own warm-up (a dev bundler) — not a
#: budget a slow app should be given more of to look healthy: an app that needs longer is a finding.
START_SECONDS = 60.0  # to open its port AND answer its health path
#: A single health probe. Local and loopback: anything slower is not answering.
PROBE_SECONDS = 2.0
#: An install's own budget (``npm ci`` on a cold cache), the same the CLI's install used.
INSTALL_SECONDS = 300.0

STEPS = ("install", "build", "start", "present")


def _answer(code: ExitCode, detail: str, *, ran: bool = True, value: Any = None) -> ReturnedValue:
    return ReturnedValue(exit_code=code, detail=detail, ran=ran, value=value)


def health_answers(port: int, path: str = "/") -> bool:
    """The app's own health path answers below 500 on ``port`` (a redirect or a 404 page is still a server).

    Asked on each loopback (``dev_server.LOOPBACKS``): a Vite or Next server on ``localhost`` listens on
    ``::1`` alone, a uvicorn on ``127.0.0.1`` alone."""
    from flow_sdk.core.dev_server import loopback_answers  # noqa: PLC0415

    return loopback_answers(port, path, timeout=PROBE_SECONDS, healthy=lambda status: status < 500)


async def _app(webapp_id: str):
    from flow_sdk.builtin.faas.micro_app import WebApp  # noqa: PLC0415

    bare = webapp_id.split("-", 1)[1] if webapp_id.startswith("micro_app-") else webapp_id
    app = await WebApp.get_by_id(bare)
    # As ``webapp.json`` declares it NOW (the setup-fixer may just have changed it): re-parsed only when
    # the file changed (``webapp_asset_hash``).
    if app is not None and await app.check_and_refresh_record():
        app = await WebApp.get_by_id(bare) or app
    return app


def _proxy(app) -> Optional[Any]:
    """The mount that is the app's dev server, or None for an app that is only files."""
    from flow_sdk.builtin.webapp_placement import app_mounts  # noqa: PLC0415

    return next((mount for mount in app_mounts(app) if mount.serving.type == "proxy"), None)


def _run(command: str, folder: Path, log_name: str, seconds: float) -> tuple[int, str]:
    """Run ``command`` in ``folder``, its output to a log; ``(exit code, last lines)``."""
    from flow_sdk.core.dev_server import log_dir, log_tail  # noqa: PLC0415

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
    return code, f"{log_tail(str(log_file))}\n(log: {log_file})"


async def _placed(app):
    """The route the app's dev server holds on this machine, or None."""
    from flow_sdk.builtin.webapp_placement import webapp_routes  # noqa: PLC0415

    return next((p for p in await webapp_routes(str(app.id)) if p.backend.type == "proxy"), None)


async def step(webapp_id: str, which: str, *, check: bool, display: str = "") -> ReturnedValue:
    """One of the app's setup/load steps (``install`` / ``build`` / ``start`` / ``present``). ``check`` judges what is ON THIS
    MACHINE now and changes nothing. Never raises for an outcome."""
    app = await _app(webapp_id)
    if app is None or not app.asset_ref:
        return _answer(ExitCode.NOT_FOUND, f"there is no web app {webapp_id!r} here", ran=False)
    if which not in STEPS:
        return _answer(ExitCode.NOT_FOUND, f"a web app has no setup step {which!r} (it has {', '.join(STEPS)})", ran=False)
    if which == "present":
        from flow_sdk.builtin.webapp_load import present  # noqa: PLC0415

        return await present(app, display=display, check=check)
    folder = Path(app.asset_ref)
    if not folder.is_dir():
        return _answer(ExitCode.NOT_FOUND, f"{app.name}'s folder is gone: {folder}", ran=False)
    processes = _processes(app)
    if not processes:
        return _answer(ExitCode.OK, f"{app.name} is files Flowpad serves itself", ran=False)
    if which == "start":
        return await _start_all(app, folder, check=check)
    # Install and build are the page's; an app that is only an API has its first service's.
    serving = processes[-1].serving
    if which == "install":
        return await _install(app, folder, serving, check=check)
    return await _build(app, folder, serving, check=check)


async def _install(app, folder: Path, serving, *, check: bool) -> ReturnedValue:
    from flow_sdk.core.dev_server import install_command  # noqa: PLC0415

    declared = serving.install_cmd
    if not declared and not (folder / "package.json").exists():
        return _answer(ExitCode.OK, "nothing to install", ran=False)
    if not declared and (folder / "node_modules").is_dir():
        return _answer(ExitCode.OK, "dependencies are installed", ran=False)
    if declared and serving.install_check:
        if (folder / serving.install_check).exists():
            return _answer(ExitCode.OK, "dependencies are installed", ran=False)
    elif declared and check and (await _start_all(app, folder, check=True)).ok:
        # A declared install with no check of its own is judged by its result: the app runs.
        return _answer(ExitCode.OK, "running, so it is installed", ran=False)
    if check:
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


@dataclass(frozen=True)
class _Process:
    """One process of an app: its page's dev server (``service`` is None), or a service it brings along."""

    serving: Any
    mount: Any = None
    service: Any = None

    @property
    def name(self) -> str:
        return self.service.name if self.service is not None else ""

    def label(self, app) -> str:
        return f"{app.name}'s {self.name} service" if self.service is not None else app.name


def _processes(app) -> list[_Process]:
    """The app's processes in start order: what the page calls first, then the page."""
    processes = [_Process(service.serving, service=service) for service in (getattr(app, "services", None) or [])]
    mount = _proxy(app)
    if mount is not None:
        processes.append(_Process(mount.serving, mount=mount))
    return processes


def _declared(serving) -> Optional[app_ports.Declared]:
    port = serving.declared_port()
    return app_ports.Declared(port.port, port.required) if port is not None else None


async def _project_apps(project_id) -> list:
    from flow_sdk.builtin.faas.micro_app import WebApp  # noqa: PLC0415

    apps = await WebApp.get_all({"match": {"project_id": project_id}}) if project_id else []
    # An app whose folder is gone declares nothing: its row is only what the index has not dropped yet.
    return [app for app in apps if app.asset_ref and Path(app.asset_ref).is_dir()]


async def _other_apps(app) -> list:
    """The other web apps of this app's project — their declared ports are not this app's to take.
    A port an app of ANOTHER project declares is not reserved ahead; it is met live, as any holder is."""
    return [other for other in await _project_apps(app.project_id) if str(other.id) != str(app.id)]


#: ``(who declares it, its process name, what it declares)`` for every declaring process of an app.
_DeclaredRow = tuple[str, str, app_ports.Declared]


def _declared_by(app) -> list[_DeclaredRow]:
    rows = [(process.label(app), process.name, _declared(process.serving)) for process in _processes(app)]
    return [row for row in rows if row[2] is not None]


async def _declared_elsewhere(app) -> list[_DeclaredRow]:
    """What every OTHER app declares — read once per call, whatever the number of processes."""
    return [row for other in await _other_apps(app) for row in _declared_by(other)]


def _elsewhere(app, process: _Process, others: list[_DeclaredRow]) -> tuple[set[int], str]:
    """``(ports other processes declare, who else REQUIRES this process's required port)``."""
    mine = _declared(process.serving)
    rows = [row for row in _declared_by(app) if row[1] != process.name] + others
    taken = {declared.port for _who, _name, declared in rows}
    clash = next(
        (who for who, _name, declared in rows
         if mine is not None and mine.required and declared.required and declared.port == mine.port),
        "",
    )
    return taken, clash


#: Ports handed to a start that has not opened them yet: two starts at once never get the same one.
_STARTING: set[int] = set()


def _look(app, process: _Process, taken: set[int], snapshot: Optional[list] = None) -> tuple[app_ports.PortAnswer, list, bool]:
    """What is declared against what is live — one trip off the loop. ``(the rule's answer, this
    process's listeners, it answers its health path)``."""
    serving = process.serving
    snapshot = app_ports.listeners() if snapshot is None else snapshot
    others = [one.serving for one in _processes(app) if one.serving is not serving]
    theirs = [declared.port for declared in map(_declared, others) if declared is not None]
    mine = app_ports.of_app(
        snapshot, Path(app.asset_ref), serving.start_cmd, [one.start_cmd for one in others], theirs
    )
    answer = app_ports.decide(
        _declared(serving), mine, snapshot,
        reserved=taken | _STARTING, answers=lambda port: health_answers(port, serving.health),
    )
    # A holder that could not be named was already asked its health by the rule.
    up = answer.state == "running" and (answer.holder is None or health_answers(answer.port, serving.health))
    return answer, mine, up


async def answers_now(webapp_id: str) -> bool:
    """Every process of the app answers its health path where its route says it runs now — one probe each,
    side by side: no process table, no start, no write. The check an open of an app it already loaded asks."""
    from flow_sdk.builtin.webapp_placement import service_endpoint_name, service_endpoint_ports  # noqa: PLC0415

    app = await _app(webapp_id)
    if app is None or not app.asset_ref:
        return False
    processes = _processes(app)
    placed = await _placed(app)
    services = await service_endpoint_ports(app) if any(p.service is not None for p in processes) else {}
    ports = [
        (placed.backend.port if placed is not None else None) if process.service is None
        else services.get(service_endpoint_name(app, process.service))
        for process in processes
    ]
    if not ports or not all(ports):
        return False
    probes = (asyncio.to_thread(health_answers, int(port), process.serving.health)
              for port, process in zip(ports, processes))
    return all(await asyncio.gather(*probes))


async def where(app, serving) -> app_ports.PortAnswer:
    """Where ``serving`` — a process of ``app`` — runs or should start: the rule's answer, changing nothing."""
    process = next((one for one in _processes(app) if one.serving is serving), _Process(serving))
    taken, _clash = _elsewhere(app, process, await _declared_elsewhere(app))
    return (await asyncio.to_thread(_look, app, process, taken))[0]


async def app_declaring(port: int, project_id):
    """The web app of ``project_id`` one of whose processes declares ``port``, or None."""
    for app in await _project_apps(project_id):
        if app.asset_ref and any(declared.port == port for _who, _name, declared in _declared_by(app)):
            return app
    return None


def port_env(name: str) -> str:
    """The environment variable a process's port is told to the app's other processes under."""
    return "FLOWPAD_APP_PORT_" + "".join(ch if ch.isalnum() else "_" for ch in name.upper())


async def _start_all(app, folder: Path, *, check: bool) -> ReturnedValue:
    """Every process of the app, what the page calls first. The answer is the page's; a process that
    does not come up stops the rest and says which one it was."""
    processes = _processes(app)
    others = await _declared_elsewhere(app)
    # A check reads the process table once for the whole app; a start reads it as it goes.
    snapshot = await asyncio.to_thread(app_ports.listeners) if check else None
    env = {port_env(name): str(declared.port) for _who, name, declared in _declared_by(app) if name}
    ran = False
    for process in processes:
        answer = await _start(app, folder, process, others, env, check=check, snapshot=snapshot)
        ran = ran or answer.ran
        if not answer.ok:
            return answer
        if process.service is not None:
            env[port_env(process.name)] = str(answer.value)
    return answer if answer.ran == ran else _answer(answer.exit_code, answer.detail, ran=ran, value=answer.value)


async def _start(
    app, folder: Path, process: _Process, others: list[_DeclaredRow], env: dict, *, check: bool,
    snapshot: Optional[list] = None,
) -> ReturnedValue:
    serving = process.serving
    who = process.label(app)
    taken, clash = _elsewhere(app, process, others)
    if clash:
        port = _declared(serving).port
        return _answer(ExitCode.NOT_YET, f"port {port} is declared by both {who} and {clash} — one of them must change", ran=False)

    found, mine, up = await asyncio.to_thread(_look, app, process, taken, snapshot)
    if not up and not check and found.state != "conflict":
        # One start per process: a load and a rooted setup run under different slots and may both arrive here.
        async with keyed_loop_lock(_START_LOCKS, f"{app.id}:{process.name}"):
            found, mine, up = await asyncio.to_thread(_look, app, process, taken)
            hung = found.state == "running" and not up
            # Flowpad's own start, from before the declared port changed, moves; one started by hand
            # is the person's to stop.
            stale = found.state == "wrong_port" and all(app_ports.launched_by(one, serving.start_cmd) for one in mine)
            if hung or stale:
                # It goes before another is started, or it keeps the port.
                await asyncio.to_thread(app_ports.stop, mine)
                found, mine, up = await asyncio.to_thread(_look, app, process, taken)
            if found.state == "start":
                return await _launch(app, folder, process, found, env)
    if found.state in ("conflict", "wrong_port"):
        # The page's reason is the app's own (its node already carries its name); a service's names it.
        named = f"{who}: " if process.service is not None else ""
        return _answer(ExitCode.NOT_YET, f"{named}{found.note}" if found.state == "conflict" else f"{who} {found.note}", ran=False)
    if up:
        await _keep(app, process, found.port, serving.start_cmd.replace("{port}", str(found.port)))
        return _answer(ExitCode.OK, f"running at http://127.0.0.1:{found.port}", ran=False, value=str(found.port))
    return _answer(ExitCode.NOT_YET, f"{who} is not {'answering' if found.state == 'running' else 'running'}", ran=False)


async def _launch(app, folder: Path, process: _Process, found: app_ports.PortAnswer, env: dict) -> ReturnedValue:
    from flow_sdk.core import dev_server  # noqa: PLC0415

    serving = process.serving
    who = process.label(app)
    declared = _declared(serving)
    port = found.port
    command = serving.start_cmd.replace("{port}", str(port))
    began = time.monotonic()
    _STARTING.add(port)
    try:
        proc, log_file = await asyncio.to_thread(
            dev_server.start_process, command, cwd=folder, port=port, name=f"{app.name}-{process.name}".strip("-"), env=env
        )

        async def failed(detail: str) -> ReturnedValue:
            await asyncio.to_thread(dev_server.stop_group, proc.pid)
            return _answer(ExitCode.NOT_YET, detail)

        # A start command may hand off to a daemon and exit 0 (``docker compose up -d``): only a non-zero
        # exit is a crash. A server that took another port than the one it was told ends the wait too.
        opened = await asyncio.to_thread(
            dev_server.wait_for_port, port, START_SECONDS,
            exited=lambda: proc.poll() not in (None, 0) or bool(app_ports.listening_under(proc.pid) - {port}),
        )
    finally:
        _STARTING.discard(port)
    code = proc.poll()
    if code:  # also when the port "opened": then it is somebody else's
        # One line: a step's reason is carried up the tree as its last line, and the server's own last
        # word is the reason, not the path of its log.
        said = (await asyncio.to_thread(dev_server.log_tail, log_file, 1)).strip()
        return await failed(f"`{command}` exited (exit {code}){': ' + said if said else ''} — log: {log_file}")
    if not opened:
        own = sorted(await asyncio.to_thread(app_ports.listening_under, proc.pid))
        if not own:
            return await failed(f"`{command}` started (pid {proc.pid}) but port {port} never opened — log: {log_file}")
        if declared is not None and declared.required:
            return await failed(
                f"{who} was started on port {port} but listens on port {own[0]} — its start command must use {{port}}"
            )
        port = own[0]  # it chose its own port: where it listens is where it is
    # The port open is not the app answering: a container's published port opens at once, the server
    # behind it a moment later. Asked again until the SAME start budget runs out — and a crash ends it.
    if not await asyncio.to_thread(_answers_by, port, serving.health, began + START_SECONDS, proc):
        return await failed(f"{who} opened port {port} but {serving.health} does not answer — log: {log_file}")
    if await _keep(app, process, port, command) is False:
        return await failed(f"{who} has no local placement to be served from")
    detail = f"running at http://127.0.0.1:{port}"
    return _answer(ExitCode.OK, f"{detail} ({found.note})" if found.note else detail, value=str(port))


def _answers_by(port: int, health: str, deadline: float, proc) -> bool:
    """The health path answers before ``deadline``. A start command that exits with an error ends the
    wait at once: a server that died will never answer."""
    while True:
        if health_answers(port, health):
            return True
        if proc.poll() not in (None, 0) or time.monotonic() >= deadline:
            return False
        time.sleep(0.25)


async def _keep(app, process: _Process, port: int, command: str):
    """The app's route (a service's endpoint) names where the process runs now. It is a copy of the live
    answer, kept for the display: written only when it does not already say this port."""
    if process.service is not None:
        return await _keep_service(app, process.service, port, command)
    placed = await _placed(app)
    if placed is not None and placed.backend.port == port:
        return True
    return await _keep_route(app, process.mount, port, command)


async def stop(webapp_id: str) -> ReturnedValue:
    """Stop every process of the app that is running here — whoever started it."""
    app = await _app(webapp_id)
    if app is None or not app.asset_ref:
        return _answer(ExitCode.NOT_FOUND, f"there is no web app {webapp_id!r} here", ran=False)

    def looks() -> list:
        snapshot = app_ports.listeners()
        return [_look(app, process, set(), snapshot) for process in _processes(app)]

    seen = await asyncio.to_thread(looks)
    found = [one for _found, mine, _up in seen for one in mine]
    # A container's published port, another user's process: there is no process of ours to end.
    unnamed = [answer.port for answer, _mine, up in seen if up and answer.holder is None]
    if unnamed:
        ports = ", ".join(str(port) for port in unnamed)
        return _answer(
            ExitCode.NOT_YET,
            f"{app.name} is served on port {ports} by a program Flowpad did not start and cannot stop — "
            "stop it where it was started",
            ran=False,
        )
    if not found:
        return _answer(ExitCode.OK, f"{app.name} is not running", ran=False)
    await asyncio.to_thread(app_ports.stop, found)
    ports = ", ".join(str(port) for port in sorted({one.port for one in found}))
    return _answer(ExitCode.OK, f"stopped {app.name} (port {ports})")


async def ports(webapp_id: str) -> list[dict]:
    """Each process of the app: the port it declares, and where it is live now."""
    app = await _app(webapp_id)
    if app is None or not app.asset_ref:
        return []
    others = await _declared_elsewhere(app)
    snapshot = await asyncio.to_thread(app_ports.listeners)
    rows = []
    for process in _processes(app):
        taken, clash = _elsewhere(app, process, others)
        found, _mine, _up = await asyncio.to_thread(_look, app, process, taken, snapshot)
        declared = _declared(process.serving)
        live = found.state in ("running", "wrong_port")
        rows.append({
            "app": app.name,
            "process": process.name or "page",
            "declared": declared.port if declared is not None else None,
            "required": bool(declared is not None and declared.required),
            "state": "conflict" if clash else "stopped" if found.state == "start" else found.state,
            "port": found.port if live else None,
            "pid": found.holder.pid if live and found.holder is not None else None,
            "note": f"also declared by {clash}" if clash else found.note,
            "log": _log_of(app, process, found.port) if live else None,
        })
    return rows


def _log_of(app, process, port) -> Optional[str]:
    """The log the process writes, where Flowpad started it (``dev_server.start_process``); None otherwise."""
    from flow_sdk.core import dev_server  # noqa: PLC0415

    name = dev_server._slug(f"{app.name}-{process.name}".strip("-"))
    log = dev_server.log_dir() / f"{name}-{port}.log"
    return str(log) if port and log.is_file() else None


async def _keep_route(app, mount, port: int, command: str) -> bool:
    """The app's dev-server route on its project's local placement now names this port. False: there is no
    placement to record it on, so nothing would ever find the server just started."""
    from flow_sdk.builtin.project import Project  # noqa: PLC0415
    from flow_sdk.builtin.webapp_placement import local_web_deployment, set_app_route, tell_hub  # noqa: PLC0415

    project = await Project.get_by_id(app.project_id) if app.project_id else None
    deployment = await local_web_deployment(project)
    if deployment is None:
        return False
    backend = {"type": "proxy", "port": port, "start_cmd": command, "health": mount.serving.health}
    _placed_route, saved = await set_app_route(deployment, app, mount, backend)
    if saved:
        tell_hub(deployment)
    return True


async def _keep_service(app, service, port: int, command: str) -> bool:
    """The service's endpoint on its project's local placement now names this port."""
    from flow_sdk.builtin.project import Project  # noqa: PLC0415
    from flow_sdk.builtin.webapp_placement import local_web_deployment, set_service_endpoint  # noqa: PLC0415

    project = await Project.get_by_id(app.project_id) if app.project_id else None
    deployment = await local_web_deployment(project)
    if deployment is None:
        return False
    backend = {"type": "proxy", "port": port, "start_cmd": command, "health": service.serving.health}
    await set_service_endpoint(deployment, app, service, backend)
    return True
