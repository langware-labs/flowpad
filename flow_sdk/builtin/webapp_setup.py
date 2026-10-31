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
from flow_sdk.core.webapp import record, stamps
from flow_sdk.core.webapp.failure import make, of_step
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode, ReturnedValue
from flow_sdk.schema.data_spec.webapp_lifecycle_spec import FailureCode, FailurePhase, LifecycleState
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
#: The one step a web app's node runs: every step above in order, each only when its check says so.
UP = "up"


def _answer(code: ExitCode, detail: str, *, ran: bool = True, value: Any = None) -> ReturnedValue:
    return ReturnedValue(exit_code=code, detail=detail, ran=ran, value=value)


def _failed(phase: str, code: str, detail: str, *, ran: bool = True, process: str = "", folder: Any = None,
            exit_code: ExitCode = ExitCode.NOT_YET) -> ReturnedValue:
    """A step that did not reach its goal, its failure typed (``webapp.failure``) in the answer's value — so
    recovery matches it by code and fingerprint, never by parsing ``detail``."""

    failure = make(FailurePhase(phase), FailureCode(code), detail, process=process, folder=folder)
    return ReturnedValue(exit_code=exit_code, detail=detail, ran=ran, value=failure.model_dump(mode="json"))


def health_answers(port: int, path: str = "/", *, declared: bool = False) -> bool:
    """The app's own health path answers on ``port``: below 500 for ``/`` (a redirect or a 404 page is still a
    server), below 400 for a DECLARED health path of its own (``/api/health``) — one that answers 404 is not there.

    Asked on each loopback (``dev_server.LOOPBACKS``): a Vite or Next server on ``localhost`` listens on
    ``::1`` alone, a uvicorn on ``127.0.0.1`` alone."""
    from flow_sdk.core.dev_server import loopback_answers  # noqa: PLC0415

    limit = 400 if declared else 500
    return loopback_answers(port, path, timeout=PROBE_SECONDS, healthy=lambda status: status < limit)


def _health_ok(port: int, serving) -> bool:
    """``health_answers`` for one process's serving, its health path declared or not."""
    path = serving.health or "/"
    return health_answers(port, path, declared=path.strip("/") != "" and "health" in getattr(serving, "model_fields_set", ()))


#: The app's own start contract, when it has one: ``setup/start_app.py`` with two commands —
#: ``start <port>`` runs the server in the foreground on ``port`` (in place of ``start_cmd``) and
#: ``check <port>`` exits 0 when the app is usable. Recovery (``recover``) is not code: it is the fixer agent
#: reading ``setup/recovery.md`` and ``setup/webapp_errors.json`` (``builtin/webapp_check``).
START_APP = "setup/start_app.py"
START_APP_CHECK_SECONDS = 20.0


def start_app_command(folder: Path, port: int) -> Optional[str]:
    """The command that starts the app through its ``setup/start_app.py``, or None when it has none."""
    return f"python3 {START_APP} start {int(port)}" if (Path(folder) / START_APP).is_file() else None


def start_app_check(folder: Path, port: int) -> bool:
    """The app's own ``check``: True when it has none, or when ``start_app.py check <port>`` exits 0."""
    import subprocess  # noqa: PLC0415

    if not (Path(folder) / START_APP).is_file():
        return True
    try:
        done = subprocess.run(["python3", START_APP, "check", str(int(port))], cwd=folder, capture_output=True,
                              timeout=START_APP_CHECK_SECONDS, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return done.returncode == 0


async def _app(webapp_id: str):
    from flow_sdk.builtin.faas.micro_app import WebApp  # noqa: PLC0415

    bare = webapp_id.removeprefix("micro_app-")
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


def _run(command: str, folder: Path, log_name: str, seconds: float, on_spawn=None) -> tuple[int, str]:
    """Run ``command`` in ``folder`` in its own process group, its output to a log; ``(exit code, last lines)``.
    Its own group, so a Stop or the step's budget ends the whole command (``npm`` and what it spawned), not only
    the shell. ``on_spawn(pid)``: told the group's pid as soon as it runs."""
    import os  # noqa: PLC0415

    from flow_sdk.core.dev_server import log_dir, log_tail  # noqa: PLC0415

    logs = log_dir()
    logs.mkdir(parents=True, exist_ok=True)
    log_file = logs / f"{log_name}.log"
    with log_file.open("ab") as log:
        proc = subprocess.Popen(  # noqa: S602 — the app author's own install/build command
            command, cwd=str(folder), shell=True, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
            start_new_session=os.name != "nt",
            creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) if os.name == "nt" else 0,
        )
        if on_spawn is not None:
            on_spawn(proc.pid)
        try:
            code = proc.wait(timeout=seconds)
        except subprocess.TimeoutExpired:
            code = 124
        if proc.poll() is None or code == 124:
            from flow_sdk.core.dev_server import stop_group  # noqa: PLC0415

            stop_group(proc.pid)  # the whole group, waited for — the one kill policy (``app_ports.kill_trees``)
    return code, f"{log_tail(str(log_file))}\n(log: {log_file})"


async def _placed(app):
    """The route the app's dev server holds on this machine, or None."""
    from flow_sdk.builtin.webapp_placement import webapp_routes  # noqa: PLC0415

    return next((p for p in await webapp_routes(str(app.id)) if p.backend.type == "proxy"), None)


async def step(webapp_id: str, which: str, *, check: bool, display: str = "", service: str = "",
               project: str = "") -> ReturnedValue:
    """One of the app's setup/load steps (``install`` / ``build`` / ``start`` / ``present``). ``check`` judges what is ON THIS
    MACHINE now and changes nothing. Never raises for an outcome. ``service``: the step ``service`` — one process
    (and what it calls first) of the app ``webapp_id`` NAMES, within ``project`` (a dependency's setup node)."""
    if which == "service":
        found = await app_named(webapp_id, project)
        webapp_id, which = (str(found.id) if found is not None else webapp_id), f"start:{service}"
    app = await _app(webapp_id)
    if app is None or not app.asset_ref:
        return _answer(ExitCode.NOT_FOUND, f"there is no web app {webapp_id!r} here", ran=False)
    if which == UP:
        return await _up(webapp_id, check=check, display=display)
    if which.startswith("start:"):
        return await _start_one(app, which.split(":", 1)[1], check=check)
    if which not in STEPS:
        return _answer(
            ExitCode.NOT_FOUND, f"a web app has no setup step {which!r} (it has {', '.join(STEPS)})", ran=False
        )
    if which == "present":
        from flow_sdk.builtin.webapp_load import present  # noqa: PLC0415

        return await present(app, display=display, check=check)
    folder = Path(app.asset_ref)
    if not folder.is_dir():
        return _failed("setup", "folder_gone", f"{app.name}'s folder is gone: {folder}", ran=False,
                       exit_code=ExitCode.NOT_FOUND)
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


#: The lifecycle state an ``up`` is in while it runs each step.
_STEP_STATE = {"install": "installing", "build": "building", "start": "starting", "present": "starting"}


async def app_named(name_or_id: str, project_id: str = ""):
    """The web app ``name_or_id`` names: by id, else by name — within ``project_id`` when there are several."""
    from flow_sdk.builtin.faas.micro_app import WebApp  # noqa: PLC0415

    bare = str(name_or_id or "").removeprefix("micro_app-")
    if not bare:
        return None
    try:
        found = await WebApp.get_by_id(bare)
    except Exception:  # noqa: BLE001 — not an id: a name
        found = None
    if found is not None:
        return found
    rows = [row for row in await WebApp.get_all({"name": bare}) if row.asset_ref and Path(row.asset_ref).is_dir()]
    mine = [row for row in rows if project_id and str(row.project_id) == str(project_id)]
    return (mine or rows or [None])[0]


async def _start_one(app, service: str, *, check: bool) -> ReturnedValue:
    """One process of the app (``service``: a service's name, ``page`` for the page) and the services declared
    before it — what it calls first. The dependency another app declares on this one (``webapp-service-up``)."""
    names = [p.name or "page" for p in _processes(app)]
    if service not in names:
        return _failed("dependency", "dependency_down",
                       f"{app.name} has no process {service!r} (it has {', '.join(names) or 'none'})", ran=False)
    return await _start_all(app, Path(app.asset_ref), check=check, upto=names.index(service) + 1)


async def _up(webapp_id: str, *, check: bool, display: str = "") -> ReturnedValue:
    """The app up and shown: install → build → start → present, each run only when its own check fails.
    Checking runs every check and answers the first that does not hold. The first step that fails ends it.
    A run (not a check) writes where it is into the app's lifecycle record, and how it ended: UP with its
    ports, or its typed failure — what recovery (``core/webapp/coordinator``) acts on."""

    app = None if check else await _app(webapp_id)
    project_id = str(getattr(app, "project_id", "") or "")
    ran = False
    answer = _answer(ExitCode.OK, "up", ran=False)
    for which in STEPS:
        held = await step(webapp_id, which, check=True, display=display)
        if held.ok:
            answer = held if which == "start" else answer
            continue
        if check:
            return held
        await record.set_state(webapp_id, LifecycleState(_STEP_STATE[which]), held.detail or which,
                               project_id=project_id)
        answer = await step(webapp_id, which, check=False, display=display)
        ran = ran or answer.ran
        if not answer.ok:

            failure = of_step(answer.value) or make(
                FailurePhase(which if which in ("install", "build", "start") else "setup"), FailureCode.UNKNOWN,
                answer.detail, folder=getattr(app, "asset_ref", None))
            await record.set_state(webapp_id, LifecycleState.FAILED, answer.detail, project_id=project_id,
                                   failure=failure)
            return answer
    if not check:
        await _record_up(webapp_id, app, project_id, answer)
    return answer if answer.ran == ran else _answer(answer.exit_code, answer.detail, ran=ran, value=answer.value)


async def _record_up(webapp_id: str, app, project_id: str, answer: ReturnedValue) -> None:
    """The app is up: its live ports and pids, the stamps of what it was installed and built from."""
    from datetime import datetime, timezone  # noqa: PLC0415


    def observe() -> dict:
        ports, pids = _live(app)
        return {"ports": ports, "pids": pids, "install_stamp": stamps.install(app), "build_stamp": stamps.build(app)}

    seen = await asyncio.to_thread(observe) if app is not None else {}
    before = record.read(webapp_id, project_id)
    page_failure = before.failure is not None and before.failure.phase.value == "page"
    await record.set_state(webapp_id, LifecycleState.UP, "up", project_id=project_id,
                           checked_at=datetime.now(timezone.utc), failure=before.failure if page_failure else None, **seen)


def _live(app) -> tuple[dict[str, int], dict[str, int]]:
    """Each process's live port and the pid listening there, from one process-table read."""
    snapshot = app_ports.listeners()
    ports: dict[str, int] = {}
    pids: dict[str, int] = {}
    for process in _processes(app):
        found, mine, up = _look(app, process, set(), snapshot)
        if found.state == "running" and up:
            ports[process.name] = int(found.port)
            if found.holder is not None:
                pids[process.name] = int(found.holder.pid)
    return ports, pids


async def _install(app, folder: Path, serving, *, check: bool) -> ReturnedValue:
    from flow_sdk.core.dev_server import install_command  # noqa: PLC0415

    declared = serving.install_cmd
    if not declared and not (folder / "package.json").exists():
        return _answer(ExitCode.OK, "nothing to install", ran=False)
    owed = await asyncio.to_thread(_owed, app, "install")
    if owed:
        if check:
            return _answer(ExitCode.NOT_YET, owed, ran=False)
        command = declared or install_command(serving.start_cmd, folder)
        return await _run_step(command, folder, f"install-{app.name}", done=f"installed with `{command}`", app=app,
                               which="install")
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
    return await _run_step(command, folder, f"install-{app.name}", done=f"installed with `{command}`", app=app,
                           which="install")


async def _build(app, folder: Path, serving, *, check: bool) -> ReturnedValue:
    command = serving.build_cmd
    if not command:
        return _answer(ExitCode.OK, "no build step", ran=False)
    built = folder / (app.build if app.build not in ("", ".") else "dist")
    owed = await asyncio.to_thread(_owed, app, "build")
    if owed:
        if check:
            return _answer(ExitCode.NOT_YET, owed, ran=False)
        return await _run_step(command, folder, f"build-{app.name}", done=f"built with `{command}`", app=app, which="build")
    if built.is_dir() and any(built.iterdir()):
        return _answer(ExitCode.OK, f"built into {built.name}/", ran=False)
    if check:
        return _answer(ExitCode.NOT_YET, "not built yet", ran=False)
    return await _run_step(command, folder, f"build-{app.name}", done=f"built with `{command}`", app=app, which="build")


def _owed(app, which: str) -> str:
    """Why the app's ``which`` (install/build) must run again although something is on disk, else ``""``: a
    run of it that never finished (its mark is still in the record), or what it was made from changed since."""

    kept = record.read(str(app.id))
    pid = kept.pids.get(which)
    if pid:
        if app_ports.pid_alive(int(pid)):
            return f"{which} is still running (pid {pid})"
        return f"the last {which} did not finish"
    was = kept.install_stamp if which == "install" else kept.build_stamp
    now = getattr(stamps, which)(app) if was else ""
    if was and now and was != now:
        return "dependencies changed since the last install" if which == "install" else "sources changed since the last build"
    return ""


async def _run_step(command: str, folder: Path, log_name: str, *, done: str, app=None, which: str = "") -> ReturnedValue:
    """Run an install/build command off the loop; its failure carries the command, its exit and its last lines.
    While it runs the app's record holds its pid under ``which`` — the mark of a step that has not finished: a
    run cut short (Stop, a restart, a kill) leaves it, and the next check redoes the step instead of trusting
    whatever half of it is on disk."""

    webapp_id = str(getattr(app, "id", "") or "")

    def mark(pid: int) -> None:
        if webapp_id and which:
            record._write(webapp_id, str(getattr(app, "project_id", "") or ""),
                          {"pids": {**record.read(webapp_id).pids, which: int(pid)}})

    code, tail = await asyncio.to_thread(_run, command, folder, log_name, INSTALL_SECONDS, mark)
    if code == 0 and webapp_id and which:
        stamp = {"install": "install_stamp", "build": "build_stamp"}[which]
        from flow_sdk.core.webapp import stamps  # noqa: PLC0415

        pids = {k: v for k, v in record.read(webapp_id).pids.items() if k != which}
        await record.change(webapp_id, pids=pids, **{stamp: getattr(stamps, which)(app)})
    if code != 0:
        phase = "build" if log_name.startswith("build-") else "install"
        return _failed(phase, "timeout" if code == 124 else "command_failed",
                       f"`{command}` failed (exit {code}):\n{tail}", folder=folder)
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
        (
            who
            for who, _name, declared in rows
            if mine is not None and mine.required and declared.required and declared.port == mine.port
        ),
        "",
    )
    return taken, clash


#: Ports handed to a start that has not opened them yet: two starts at once never get the same one.
_STARTING: set[int] = set()


def _look(
    app, process: _Process, taken: set[int], snapshot: Optional[list] = None
) -> tuple[app_ports.PortAnswer, list, bool]:
    """What is declared against what is live — one trip off the loop. ``(the rule's answer, this
    process's listeners, it answers its health path)``."""
    serving = process.serving
    snapshot = app_ports.listeners() if snapshot is None else snapshot
    others = [one.serving for one in _processes(app) if one.serving is not serving]
    theirs = [declared.port for declared in map(_declared, others) if declared is not None]
    mine = app_ports.of_app(snapshot, Path(app.asset_ref), serving.start_cmd, [one.start_cmd for one in others], theirs)
    answer = app_ports.decide(
        _declared(serving),
        mine,
        snapshot,
        reserved=taken | _STARTING,
        answers=lambda port: _health_ok(port, serving),
    )
    # A holder that could not be named was already asked its health by the rule.
    up = answer.state == "running" and (answer.holder is None or _health_ok(answer.port, serving))
    return answer, mine, up


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


async def _start_all(app, folder: Path, *, check: bool, upto: Optional[int] = None) -> ReturnedValue:
    """Every process of the app (``upto``: only the first that many), what the page calls first. The answer is
    the last one's; a process that does not come up stops the rest and says which one it was."""
    processes = _processes(app)[:upto]
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
    app,
    folder: Path,
    process: _Process,
    others: list[_DeclaredRow],
    env: dict,
    *,
    check: bool,
    snapshot: Optional[list] = None,
) -> ReturnedValue:
    serving = process.serving
    who = process.label(app)
    taken, clash = _elsewhere(app, process, others)
    if clash:
        port = _declared(serving).port
        return _failed("start", "port_conflict",
                       f"port {port} is declared by both {who} and {clash} — one of them must change", ran=False,
                       process=process.name, folder=folder)

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
        return _failed("start", "port_held" if found.state == "conflict" else "wrong_port",
                       f"{named}{found.note}" if found.state == "conflict" else f"{who} {found.note}", ran=False,
                       process=process.name, folder=folder)
    if up:
        await _keep(app, process, found.port, serving.start_cmd.replace("{port}", str(found.port)))
        return _answer(ExitCode.OK, f"running at http://127.0.0.1:{found.port}", ran=False, value=str(found.port))
    hung = found.state == "running"
    return _failed("health" if hung else "start", "health_no_answer" if hung else "exited",
                   f"{who} is not {'answering' if hung else 'running'}", ran=False, process=process.name, folder=folder)


async def _launch(app, folder: Path, process: _Process, found: app_ports.PortAnswer, env: dict) -> ReturnedValue:
    from flow_sdk.core import dev_server  # noqa: PLC0415

    serving = process.serving
    who = process.label(app)
    declared = _declared(serving)
    port = found.port
    command = start_app_command(folder, port) or serving.start_cmd.replace("{port}", str(port))
    began = time.monotonic()
    oom_before = await asyncio.to_thread(dev_server.oom_kills)
    _STARTING.add(port)
    try:
        proc, log_file = await asyncio.to_thread(
            dev_server.start_process,
            command,
            cwd=folder,
            port=port,
            name=f"{app.name}-{process.name}".strip("-"),
            env=env,
        )

        async def failed(detail: str, code: str = "exited", phase: str = "start") -> ReturnedValue:
            starved = await _out_of_memory(who, oom_before, log_file)
            await asyncio.to_thread(dev_server.stop_group, proc.pid)
            if starved:
                return _failed("start", "out_of_memory", starved, process=process.name, folder=folder)
            return _failed(phase, code, detail, process=process.name, folder=folder)

        # A start command may hand off to a daemon and exit 0 (``docker compose up -d``): only a non-zero
        # exit is a crash. A server that took another port than the one it was told ends the wait too.
        opened = await asyncio.to_thread(
            dev_server.wait_for_port,
            port,
            START_SECONDS,
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
            return await failed(f"`{command}` started (pid {proc.pid}) but port {port} never opened — log: {log_file}",
                                "port_never_opened")
        if declared is not None and declared.required:
            return await failed(
                f"{who} was started on port {port} but listens on port {own[0]} — its start command must use {{port}}",
                "wrong_port")
        port = own[0]  # it chose its own port: where it listens is where it is
    # The port open is not the app answering: a container's published port opens at once, the server
    # behind it a moment later. Asked again until the SAME start budget runs out — and a crash ends it.
    if not await asyncio.to_thread(_answers_by, port, serving, began + START_SECONDS, proc):
        return await failed(f"{who} opened port {port} but {serving.health} does not answer — log: {log_file}",
                            "health_no_answer", "health")
    if await _keep(app, process, port, command) is False:
        return await failed(f"{who} has no local placement to be served from", "no_placement", "setup")
    detail = f"running at http://127.0.0.1:{port}"
    return _answer(ExitCode.OK, f"{detail} ({found.note})" if found.note else detail, value=str(port))


async def _out_of_memory(who: str, before: Optional[int], log_file: str) -> Optional[str]:
    """Why a start failed when the kernel killed processes for lack of memory while it ran, else None.

    A killed server never answers, so the start reads "does not answer" — true, and it sends the reader
    to the app's code. The kernel's own count names the cause: this machine is too small for what runs on it."""
    from flow_sdk.core import dev_server  # noqa: PLC0415

    after = await asyncio.to_thread(dev_server.oom_kills)
    if before is None or after is None or after <= before:
        return None
    killed = after - before
    return (
        f"{who} ran out of memory: the machine killed {killed} process{'es' if killed > 1 else ''} "
        f"for lack of memory while it started — log: {log_file}"
    )


def _answers_by(port: int, serving, deadline: float, proc) -> bool:
    """The health path answers before ``deadline``. A start command that exits with an error ends the
    wait at once: a server that died will never answer."""
    while True:
        if _health_ok(port, serving):
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
        found, mine, _up = await asyncio.to_thread(_look, app, process, taken, snapshot)
        declared = _declared(process.serving)
        live = found.state in ("running", "wrong_port")
        # What the running process no longer matches in the saved definition: a restart applies it.
        changes = []
        if found.state == "wrong_port" and declared is not None:
            changes.append(f"port {found.port} → {declared.port}")
        if live and mine and not any(app_ports.launched_by(one, process.serving.start_cmd) for one in mine):
            changes.append("start command")
        rows.append(
            {
                "app": app.name,
                "process": process.name or "page",
                "declared": declared.port if declared is not None else None,
                "required": bool(declared is not None and declared.required),
                "state": "conflict" if clash else "stopped" if found.state == "start" else found.state,
                "port": found.port if live else None,
                "pid": found.holder.pid if live and found.holder is not None else None,
                "note": f"also declared by {clash}" if clash else found.note,
                "log": _log_of(app, process, found.port) if live else None,
                "changes": changes,
                "lint": _lint(process.serving),
            }
        )
    return rows


def _lint(serving) -> list[str]:
    """What a process's serving should declare and does not: readiness is judged on its health path, and a
    port nothing declares is picked fresh each start (docs/webapp-lifecycle.md)."""
    declared = getattr(serving, "model_fields_set", set())
    out = []
    if "health" not in declared:
        out.append("declare `health`: a path of the app's own that answers once it is up (`/` is assumed)")
    if serving.declared_port() is None:
        out.append("declare `ports.local.port` (required or not) so the app keeps one address")
    return out


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
