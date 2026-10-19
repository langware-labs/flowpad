"""``webapp_setup.step`` — install, build, start, each with a check; a real process on a real port.

The app is a temp folder whose "dev server" is ``python -m http.server``; its endpoint lookup and the
placement write are stubbed (no DB). What is pinned: install runs once, start comes up and is then
"already running", and a start never adopts a port another program holds.
"""

from __future__ import annotations

import asyncio
import os
import signal
import socket
import subprocess
import sys
import time
from types import SimpleNamespace

import pytest

from flow_sdk.builtin import webapp_setup
from flow_sdk.core import dev_server
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode
from flow_sdk.schema.data_spec.webapp_spec import WebappMountSpec, WebappServiceSpec

pytestmark = pytest.mark.timeout(20)

SERVER = f"{sys.executable} -m http.server {{port}} --bind 127.0.0.1"


@pytest.fixture
def app(tmp_path, monkeypatch):
    folder = tmp_path / "site"
    folder.mkdir()
    (folder / "index.html").write_text("ok")
    state = SimpleNamespace(endpoint=None, started=[], procs=[], rows={}, services={}, by_hand=[])

    def make(*, install_cmd="", port=None, ports=None, package=False, start_cmd=SERVER, services=(), id="a1",
             install_check="", at=None):
        home = at or folder
        home.mkdir(exist_ok=True)
        if package:
            (home / "package.json").write_text("{}")
        serving = {"type": "proxy", "start_cmd": start_cmd, "health": "/", "install_cmd": install_cmd,
                   "install_check": install_check}
        if port:
            serving["port"] = port
        if ports:
            serving["ports"] = {"local": ports}
        row = SimpleNamespace(
            id=id, name=home.name, asset_ref=str(home), build=".", project_id=None,
            mounts=[WebappMountSpec(serving=serving)],
            services=[WebappServiceSpec.model_validate(service) for service in services],
        )
        state.rows[id] = row
        return row

    async def by_id(webapp_id):
        return state.rows.get(webapp_id)

    async def others(row):
        return [other for other in state.rows.values() if other.id != row.id]

    async def placed(_app):
        return state.endpoint

    async def keep(_app, mount, port, command):
        state.endpoint = SimpleNamespace(mount="site", backend=SimpleNamespace(type="proxy", port=port))

    async def keep_service(_app, service, port, command):
        state.services[service.name] = port

    real_start = dev_server.start_process

    def start(command, **kw):
        proc, log = real_start(command, **kw)
        state.started.append(proc.pid)
        state.procs.append(proc)
        return proc, log

    def by_hand(port, *, command=None):
        """A server somebody starts themselves, in the app folder — no Flowpad start involved."""
        proc = subprocess.Popen(  # noqa: S603
            command or [sys.executable, "-m", "http.server", str(port), "--bind", "127.0.0.1"],
            cwd=str(folder), start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        state.by_hand.append(proc)
        assert dev_server.wait_for_port(port, 10), "the hand-started server never opened its port"
        return proc

    monkeypatch.setattr(webapp_setup, "_app", by_id)
    monkeypatch.setattr(webapp_setup, "_other_apps", others)
    monkeypatch.setattr(webapp_setup, "_placed", placed)
    monkeypatch.setattr(webapp_setup, "_keep_route", keep)
    monkeypatch.setattr(webapp_setup, "_keep_service", keep_service)
    monkeypatch.setattr(dev_server, "start_process", start)
    monkeypatch.setattr(dev_server, "log_dir", lambda: tmp_path / "logs")
    state.make, state.folder, state.by_hand_start = make, folder, by_hand
    yield state
    # Every process this test started goes, through the handle it holds: a live handle keeps its pid from
    # being handed to another process, so this never ends a stranger.
    for proc in [*state.procs, *state.by_hand]:
        if proc.poll() is None:
            dev_server.stop_group(proc.pid)
        proc.wait()
    # A server a start handed off to (it outlives its start command) is found by where it serves. Not on
    # Windows: reading the whole process table there right after killing hung the cleanup for minutes on
    # the test VM, and such a test stops what it started itself.
    if sys.platform != "win32":
        home = os.path.realpath(tmp_path)
        webapp_setup.app_ports.stop(
            [one for one in webapp_setup.app_ports.listeners() if webapp_setup.app_ports._inside(one.cwd, home)]
        )


def _free() -> int:
    return webapp_setup.app_ports.free_port()


@pytest.mark.asyncio
async def test_install_runs_once_and_its_check_reads_the_folder(app):
    app.make(package=True, install_cmd="")
    (app.folder / "package-lock.json").write_text("{}")
    assert dev_server.install_command("npm run dev", app.folder) == "npm ci"

    app.make(install_cmd=f"{sys.executable} -c \"open('installed','w')\"")
    first = await webapp_setup.step("a1", "install", check=False)
    assert first.ok and (app.folder / "installed").exists()


@pytest.mark.asyncio
async def test_an_install_that_fails_says_why(app):
    app.make(install_cmd=f"{sys.executable} -c \"raise SystemExit('no network')\"")
    answer = await webapp_setup.step("a1", "install", check=False)
    assert answer.exit_code is ExitCode.NOT_YET and "exit 1" in answer.detail and "no network" in answer.detail


@pytest.mark.asyncio
async def test_start_brings_the_app_up_and_then_it_is_already_running(app):
    app.make()
    assert (await webapp_setup.step("a1", "start", check=True)).exit_code is ExitCode.NOT_YET

    started = await webapp_setup.step("a1", "start", check=False)
    assert started.ok and started.ran, started.detail
    port = int(started.value)
    assert webapp_setup.health_answers(port)

    again = await webapp_setup.step("a1", "start", check=True)
    assert again.ok and not again.ran and str(port) in again.detail
    assert len(app.started) == 1


@pytest.mark.asyncio
async def test_a_fixed_port_another_program_holds_is_reported_never_adopted(app):
    squatter = socket.socket()
    squatter.bind(("127.0.0.1", 0))
    squatter.listen()
    port = squatter.getsockname()[1]
    try:
        app.make(port=port)
        answer = await webapp_setup.step("a1", "start", check=False)
    finally:
        squatter.close()
    assert answer.exit_code is ExitCode.NOT_YET and f"port {port} is held by another program" in answer.detail
    assert app.started == []


def _alive(pid: int) -> bool:
    import psutil

    try:
        return psutil.Process(pid).status() != psutil.STATUS_ZOMBIE
    except psutil.Error:
        return False


def _kill(pid: int) -> None:
    """The server dies the way a crash or an OOM kill takes it: no goodbye."""
    dev_server.stop_group(pid)


@pytest.mark.asyncio
async def test_a_start_command_that_crashes_is_reported_at_once_with_its_own_words(app):
    app.make(start_cmd=f"{sys.executable} -c \"raise SystemExit('no such module vite')\"")
    began = time.monotonic()
    answer = await webapp_setup.step("a1", "start", check=False)
    assert answer.exit_code is ExitCode.NOT_YET
    assert "exited (exit 1): no such module vite" in answer.detail.splitlines()[-1]
    assert time.monotonic() - began < 5, "a crash must not wait out the start budget"
    assert app.endpoint is None


@pytest.mark.asyncio
async def test_a_server_that_opens_its_port_but_never_answers_is_killed_not_left_holding_it(app, monkeypatch):
    hang = (
        f"{sys.executable} -c \"import socket,time; s=socket.socket(); "
        "s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); "
        "s.bind(('127.0.0.1', {port})); s.listen(); time.sleep(600)\""
    )
    app.make(start_cmd=hang)
    monkeypatch.setattr(webapp_setup, "PROBE_SECONDS", 0.5)
    # It is asked until the start budget runs out; here a short one, so the test does not wait a minute.
    monkeypatch.setattr(webapp_setup, "START_SECONDS", 2.0)
    answer = await webapp_setup.step("a1", "start", check=False)
    assert answer.exit_code is ExitCode.NOT_YET and "does not answer" in answer.detail
    assert not _alive(app.started[0]), "the hung server we started must not outlive the failed start"


@pytest.mark.asyncio
async def test_a_killed_server_is_not_running_and_the_next_start_brings_it_back(app):
    app.make()
    first = await webapp_setup.step("a1", "start", check=False)
    assert first.ok, first.detail
    _kill(app.started[0])

    assert (await webapp_setup.step("a1", "start", check=True)).exit_code is ExitCode.NOT_YET
    again = await webapp_setup.step("a1", "start", check=False)
    assert again.ok and again.ran, again.detail
    assert len(app.started) == 2 and webapp_setup.health_answers(int(again.value))


@pytest.mark.asyncio
async def test_another_program_on_the_dead_apps_port_is_never_taken_for_the_app(app):
    """The app died; something else answers on the port its endpoint still names. Health alone says
    "running" — and the tab would show the other program."""
    import http.server
    import threading

    app.make()
    first = await webapp_setup.step("a1", "start", check=False)
    port = int(first.value)
    _kill(app.started[0])
    squatter = http.server.ThreadingHTTPServer(("127.0.0.1", port), http.server.SimpleHTTPRequestHandler)
    threading.Thread(target=squatter.serve_forever, daemon=True).start()
    try:
        assert webapp_setup.health_answers(port)
        assert (await webapp_setup.step("a1", "start", check=True)).exit_code is ExitCode.NOT_YET
        moved = await webapp_setup.step("a1", "start", check=False)
        assert moved.ok and int(moved.value) != port, moved.detail
    finally:
        squatter.shutdown()
        squatter.server_close()


@pytest.mark.asyncio
async def test_a_server_the_person_runs_themselves_in_the_app_folder_is_the_app(app):
    """No start of ours launched it (a terminal, an agent, ``flow app open``): it is found by where it
    runs, adopted on its port, and never started a second time."""
    port = _free()
    app.by_hand_start(port)
    app.make(ports={"port": port})
    for check in (True, False):
        answer = await webapp_setup.step("a1", "start", check=check)
        assert answer.ok and not answer.ran and answer.value == str(port), answer.detail
    assert app.started == [] and app.endpoint.backend.port == port


@pytest.mark.asyncio
async def test_two_starts_at_once_launch_one_server(app):
    app.make()
    first, second = await asyncio.gather(
        webapp_setup.step("a1", "start", check=False), webapp_setup.step("a1", "start", check=False)
    )
    assert first.ok and second.ok and first.value == second.value
    assert len(app.started) == 1


@pytest.mark.asyncio
async def test_an_app_whose_folder_is_gone_says_so(app):
    import shutil

    app.make()
    shutil.rmtree(app.folder)
    answer = await webapp_setup.step("a1", "start", check=False)
    assert answer.exit_code is ExitCode.NOT_FOUND and "folder is gone" in answer.detail
    assert app.started == []


@pytest.mark.asyncio
async def test_a_start_with_nowhere_to_record_its_endpoint_fails_and_leaves_nothing_running(app, monkeypatch):
    async def nowhere(*_a, **_kw):
        return False

    app.make()
    monkeypatch.setattr(webapp_setup, "_keep_route", nowhere)
    answer = await webapp_setup.step("a1", "start", check=False)
    assert answer.exit_code is ExitCode.NOT_YET and "no local placement" in answer.detail
    assert not _alive(app.started[0])


@pytest.mark.asyncio
async def test_an_app_that_is_only_files_has_nothing_to_set_up(app):
    row = SimpleNamespace(id="a1", name="site", asset_ref=str(app.folder), build=".", project_id=None, mounts=[], services=[])
    app.rows["a1"] = row
    answer = await webapp_setup.step("a1", "start", check=False)
    assert answer.ok and not answer.ran


@pytest.mark.asyncio
async def test_an_unknown_app_or_step_is_not_found(app):
    assert (await webapp_setup.step("gone", "start", check=True)).exit_code is ExitCode.NOT_FOUND
    app.make()
    assert (await webapp_setup.step("a1", "deploy", check=True)).exit_code is ExitCode.NOT_FOUND


@pytest.mark.asyncio
async def test_a_failed_recheck_answered_in_process_says_its_own_reason(monkeypatch, tmp_path):
    """The check is a step this backend answers: when the call ran and it still fails, its reason is
    the op's detail — not the bare "the call ran, but the check still fails"."""
    from flow_sdk.core.compute_op import runner
    from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec
    from flow_sdk.schema.data_spec.returned_value_spec import CliResult, ReturnedValue

    async def step(webapp, which, *, check, display=""):
        return ReturnedValue(exit_code=ExitCode.NOT_YET if check else ExitCode.OK,
                             detail="port 3000 is held by another program" if check else "started")

    monkeypatch.setattr(webapp_setup, "step", step)
    op = ComputeOpSpec.model_validate({"name": "start", "label": "Start", "subkind": "cli",
                                       "exe_data": {"webapp_step": "start"}, "completion_check": {"webapp_step": "start"}})

    async def shell(command, **_kw):
        return CliResult.of_process(command, 0)

    answer = await runner.run_op(op, trusted=True, platform="linux", workdir=tmp_path, shell=shell,
                                 env={"FLOWPAD_WIZARD_INPUT_WEBAPP": "a1"})
    assert answer.exit_code is ExitCode.NOT_YET
    assert answer.detail == "Start: port 3000 is held by another program"


def test_a_server_on_the_ipv6_loopback_alone_is_seen_by_both_probes():
    """Vite / Next on ``localhost`` bind ``::1`` only on a modern Node: the port probe and the health probe
    must find them, or every such start is called "never opened" while its log says ready."""
    import http.server
    import socket
    import threading

    from flow_sdk.core import dev_server

    if not socket.has_ipv6:
        pytest.skip("no IPv6 loopback here")

    class V6(http.server.ThreadingHTTPServer):
        address_family = socket.AF_INET6

    class Quiet(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.end_headers()

        def log_message(self, *_a):
            pass

    try:
        server = V6(("::1", 0), Quiet)
    except OSError:
        pytest.skip("cannot bind ::1 here")
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        assert dev_server.port_open(port)
        assert webapp_setup.health_answers(port, "/")
    finally:
        server.shutdown()
        server.server_close()
    assert not dev_server.port_open(port) and not webapp_setup.health_answers(port, "/")


# ── the port rule, on real processes ─────────────────────────────────────────────────────────────

HANG = (
    "import socket,sys,time; s=socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); "
    "s.bind(('127.0.0.1', int(sys.argv[1]))); s.listen(); time.sleep(600)"
)


def _squat() -> socket.socket:
    """Another program holding a port: a listener in THIS process, which runs nowhere near the app."""
    held = socket.socket()
    held.bind(("127.0.0.1", 0))
    held.listen()
    return held


@pytest.mark.asyncio
async def test_a_required_port_that_is_free_is_where_the_app_starts(app):
    port = _free()
    app.make(ports={"port": port, "required": True})
    started = await webapp_setup.step("a1", "start", check=False)
    assert started.ok and started.value == str(port), started.detail


@pytest.mark.asyncio
async def test_a_required_port_held_by_another_program_names_who_holds_it_and_starts_nothing(app):
    held = _squat()
    port = held.getsockname()[1]
    try:
        app.make(ports={"port": port, "required": True})
        for check in (True, False):
            answer = await webapp_setup.step("a1", "start", check=check)
            assert answer.exit_code is ExitCode.NOT_YET
            assert f"port {port} is held by another program: " in answer.detail and f"(pid {os.getpid()})" in answer.detail
    finally:
        held.close()
    assert app.started == [] and app.endpoint is None


@pytest.mark.asyncio
async def test_a_preferred_port_that_is_busy_moves_to_a_free_one_and_says_so(app):
    held = _squat()
    port = held.getsockname()[1]
    try:
        app.make(ports={"port": port, "required": False})
        started = await webapp_setup.step("a1", "start", check=False)
    finally:
        held.close()
    assert started.ok and started.value != str(port), started.detail
    assert f"port {port} is busy, so it runs on port {started.value}" in started.detail
    assert app.endpoint.backend.port == int(started.value)


@pytest.mark.asyncio
async def test_the_app_started_by_hand_on_another_port_than_it_requires_is_reported(app):
    wrong, right = _free(), _free()
    # Not the app's own start command: one started with exactly that is Flowpad's to move.
    app.by_hand_start(wrong, command=[sys.executable, "-m", "http.server", str(wrong), "--bind", "127.0.0.1", "--directory", "."])
    app.make(ports={"port": right, "required": True})
    answer = await webapp_setup.step("a1", "start", check=False)
    assert answer.exit_code is ExitCode.NOT_YET
    assert f"is running on port {wrong}" in answer.detail and f"can only run on port {right}" in answer.detail
    assert app.started == [], "a server the person started is theirs to stop"


@pytest.mark.asyncio
async def test_the_server_outlives_the_shell_that_started_it_and_is_still_found_and_stopped(app):
    app.make()
    started = await webapp_setup.step("a1", "start", check=False)
    port = int(started.value)
    shell = app.started[0]
    import psutil

    server = next(child for child in psutil.Process(shell).children(recursive=True) if child.pid != shell) if (
        psutil.Process(shell).children()
    ) else None
    if server is None:
        pytest.skip("this shell became the server itself: there is no shell to lose")
    os.kill(shell, signal.SIGTERM if sys.platform == "win32" else signal.SIGKILL)
    psutil.wait_procs([psutil.Process(shell)])
    assert webapp_setup.health_answers(port)

    again = await webapp_setup.step("a1", "start", check=True)
    assert again.ok and again.value == str(port), again.detail
    stopped = await webapp_setup.stop("a1")
    assert stopped.ok and str(port) in stopped.detail
    assert not dev_server.port_open(port)


@pytest.mark.asyncio
async def test_nothing_is_remembered_so_a_backend_that_restarts_finds_the_app_where_it_runs(app):
    """A restarted backend has no memory of the start, and here not even the route: the process table
    alone says the app runs, and on which port."""
    app.make()
    started = await webapp_setup.step("a1", "start", check=False)
    app.endpoint = None
    again = await webapp_setup.step("a1", "start", check=False)
    assert again.ok and not again.ran and again.value == started.value
    assert len(app.started) == 1 and app.endpoint.backend.port == int(started.value)


@pytest.mark.asyncio
async def test_a_hung_server_of_ours_is_replaced_by_a_start(app, monkeypatch):
    port = _free()
    app.by_hand_start(port, command=[sys.executable, "-c", HANG, str(port)])
    monkeypatch.setattr(webapp_setup, "PROBE_SECONDS", 0.5)
    app.make(ports={"port": port, "required": True})
    assert "is not answering" in (await webapp_setup.step("a1", "start", check=True)).detail
    started = await webapp_setup.step("a1", "start", check=False)
    assert started.ok and started.ran and started.value == str(port), started.detail
    assert webapp_setup.health_answers(port)


@pytest.mark.asyncio
async def test_a_start_command_that_ignores_its_port_is_adopted_where_it_listens(app):
    own = _free()
    app.make(start_cmd=f"{sys.executable} -m http.server {own} --bind 127.0.0.1")
    began = time.monotonic()
    started = await webapp_setup.step("a1", "start", check=False)
    assert started.ok and started.value == str(own), started.detail
    assert time.monotonic() - began < 10, "a server on its own port must not wait out the start budget"
    assert app.endpoint.backend.port == own


@pytest.mark.asyncio
async def test_a_start_command_that_ignores_a_required_port_is_an_error_and_leaves_nothing_running(app):
    own, declared = _free(), _free()
    app.make(start_cmd=f"{sys.executable} -m http.server {own} --bind 127.0.0.1", ports={"port": declared})
    answer = await webapp_setup.step("a1", "start", check=False)
    assert answer.exit_code is ExitCode.NOT_YET
    assert f"was started on port {declared} but listens on port {own}" in answer.detail
    assert not dev_server.port_open(own) and app.endpoint is None


@pytest.mark.asyncio
async def test_two_apps_that_require_the_same_port_are_told_before_either_starts(app, tmp_path):
    port = _free()
    app.make(ports={"port": port})
    app.make(id="a2", at=tmp_path / "other", ports={"port": port})
    for check in (True, False):
        answer = await webapp_setup.step("a1", "start", check=check)
        assert answer.exit_code is ExitCode.NOT_YET
        assert answer.detail == f"port {port} is declared by both site and other — one of them must change"
    assert app.started == []


@pytest.mark.asyncio
async def test_a_picked_port_is_never_one_another_app_declares(app, tmp_path, monkeypatch):
    declared = _free()
    app.make(id="a2", at=tmp_path / "other", ports={"port": declared})
    app.make()
    real = webapp_setup.app_ports.free_port

    def pick(taken):
        assert declared in taken, "the picker must be told what other apps declare"
        return real(taken)

    monkeypatch.setattr(webapp_setup.app_ports, "free_port", pick)
    started = await webapp_setup.step("a1", "start", check=False)
    assert started.ok and started.value != str(declared), started.detail


@pytest.mark.asyncio
async def test_two_apps_started_together_get_different_ports(app, tmp_path):
    app.make()
    app.make(id="a2", at=tmp_path / "other")
    first, second = await asyncio.gather(
        webapp_setup.step("a1", "start", check=False), webapp_setup.step("a2", "start", check=False)
    )
    assert first.ok and second.ok and first.value != second.value, (first.detail, second.detail)


def _service(port=None, command=None, name="api"):
    serving = {"type": "proxy", "start_cmd": command or f"{sys.executable} -m http.server {{port}} --bind 127.0.0.1 --directory ."}
    if port:
        serving["ports"] = {"local": {"port": port}}
    return {"name": name, "protocol": {"spec_kind": "api.rest"}, "serving": serving}


@pytest.mark.asyncio
async def test_a_service_starts_before_the_page_and_the_page_is_told_its_port(app):
    """The page writes what it was told into a file it then serves: the API's port reached it."""
    page = (
        f"{sys.executable} -c \"import os; open('told','w').write(os.environ.get('FLOWPAD_APP_PORT_API',''))\" && "
        f"{sys.executable} -m http.server {{port}} --bind 127.0.0.1"
    )
    app.make(start_cmd=page, services=[_service()])
    started = await webapp_setup.step("a1", "start", check=False)
    assert started.ok and started.ran, started.detail
    api = app.services["api"]
    assert webapp_setup.health_answers(api) and (app.folder / "told").read_text() == str(api)
    assert started.value == str(app.endpoint.backend.port) != str(api)

    again = await webapp_setup.step("a1", "start", check=True)
    assert again.ok and not again.ran and len(app.started) == 2


@pytest.mark.asyncio
async def test_a_service_that_does_not_start_stops_the_page_and_is_named(app):
    broken = _service(command=f"{sys.executable} -c \"raise SystemExit('no database')\"")
    app.make(services=[broken])
    answer = await webapp_setup.step("a1", "start", check=False)
    assert answer.exit_code is ExitCode.NOT_YET and "no database" in answer.detail
    assert len(app.started) == 1 and app.endpoint is None, "the page must not start without its service"


@pytest.mark.asyncio
async def test_a_service_that_died_comes_back_on_its_port_and_the_page_is_left_alone(app):
    port = _free()
    app.make(services=[_service(port)])
    first = await webapp_setup.step("a1", "start", check=False)
    assert first.ok, first.detail
    service_pid, page_pid = app.started
    dev_server.stop_group(service_pid)
    assert "site's api service is not running" in (await webapp_setup.step("a1", "start", check=True)).detail

    again = await webapp_setup.step("a1", "start", check=False)
    assert again.ok and again.value == first.value, again.detail
    assert app.services["api"] == port and webapp_setup.health_answers(port)
    assert _alive(page_pid) and len(app.started) == 3


@pytest.mark.asyncio
async def test_stop_frees_the_port_and_a_start_takes_it_again(app):
    port = _free()
    app.make(ports={"port": port})
    assert (await webapp_setup.step("a1", "start", check=False)).ok
    stopped = await webapp_setup.stop("a1")
    assert stopped.ok and stopped.ran and not dev_server.port_open(port)
    assert (await webapp_setup.stop("a1")).detail == "site is not running"
    again = await webapp_setup.step("a1", "start", check=False)
    assert again.ok and again.ran and again.value == str(port)


@pytest.mark.asyncio
async def test_a_declared_port_that_changes_moves_the_app_flowpad_started(app):
    old, new = _free(), _free()
    app.make(ports={"port": old})
    assert (await webapp_setup.step("a1", "start", check=False)).value == str(old)
    app.make(ports={"port": new})
    assert "can only run on port" in (await webapp_setup.step("a1", "start", check=True)).detail
    moved = await webapp_setup.step("a1", "start", check=False)
    assert moved.ok and moved.value == str(new), moved.detail
    assert not dev_server.port_open(old) and app.endpoint.backend.port == new


@pytest.mark.asyncio
async def test_a_start_that_hands_off_to_a_server_of_its_own_and_exits_is_running(app):
    """``nohup server &``: the start command exits 0 and what it left behind serves from the app folder."""
    detach = (
        f"{sys.executable} -c \"import subprocess,sys; subprocess.Popen([sys.executable,'-m','http.server','{{port}}',"
        "'--bind','127.0.0.1'], start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\""
    )
    app.make(start_cmd=detach)
    started = await webapp_setup.step("a1", "start", check=False)
    assert started.ok, started.detail
    again = await webapp_setup.step("a1", "start", check=False)
    assert again.ok and not again.ran and again.value == started.value
    assert (await webapp_setup.stop("a1")).ok and not dev_server.port_open(int(started.value))


@pytest.mark.asyncio
async def test_the_ports_of_an_app_are_listed_declared_and_live(app):
    port = _free()
    app.make(ports={"port": port}, services=[_service()])
    before = await webapp_setup.ports("a1")
    assert [(row["process"], row["declared"], row["state"], row["port"]) for row in before] == [
        ("api", None, "stopped", None), ("page", port, "stopped", None)]
    assert (await webapp_setup.step("a1", "start", check=False)).ok
    api, page = await webapp_setup.ports("a1")
    assert (page["state"], page["port"], page["required"]) == ("running", port, True) and page["pid"]
    assert (api["state"], api["port"]) == ("running", app.services["api"])


@pytest.mark.asyncio
async def test_a_page_and_a_service_started_by_one_command_each_keep_their_port(app):
    """Both ``python -m http.server {port}`` in one folder: the command cannot tell them apart, the ports
    they declare do. Found on a real cloud box: the page's server was taken for the API on a wrong port,
    so a restart never brought the API back."""
    page, api = _free(), _free()
    app.make(ports={"port": page}, services=[_service(api, command=SERVER)])
    for _ in range(2):
        assert (await webapp_setup.step("a1", "start", check=False)).ok
        rows = {row["process"]: (row["state"], row["port"]) for row in await webapp_setup.ports("a1")}
        assert rows == {"page": ("running", page), "api": ("running", api)}
        assert (await webapp_setup.stop("a1")).ok
        assert not dev_server.port_open(page) and not dev_server.port_open(api)


@pytest.mark.asyncio
async def test_a_declared_install_is_judged_by_its_check_or_by_the_app_running(app):
    """A declared install had no way to read as done: an installed, running app stayed "Setup required"."""
    app.make(install_cmd=f"{sys.executable} -c \"open('deps','w')\"", install_check="deps")
    assert (await webapp_setup.step("a1", "install", check=True)).exit_code is ExitCode.NOT_YET
    assert (await webapp_setup.step("a1", "install", check=False)).ok
    done = await webapp_setup.step("a1", "install", check=True)
    assert done.ok and done.detail == "dependencies are installed"

    app.make(install_cmd=f"{sys.executable} -c pass")
    assert (await webapp_setup.step("a1", "install", check=True)).exit_code is ExitCode.NOT_YET
    assert (await webapp_setup.step("a1", "start", check=False)).ok
    running = await webapp_setup.step("a1", "install", check=True)
    assert running.ok and running.detail == "running, so it is installed"


@pytest.mark.asyncio
async def test_a_port_held_by_something_that_cannot_be_named_is_the_app_by_its_health_and_cannot_be_stopped(
    app, monkeypatch
):
    """A container's published port (or another user's process) is in no process table we can read.
    The app's declared port answering its health path is all there is to ask — and there is nothing of
    ours to end, which stop says instead of calling a served app "not running"."""
    import http.server
    import threading

    served = http.server.ThreadingHTTPServer(("127.0.0.1", 0), http.server.SimpleHTTPRequestHandler)
    threading.Thread(target=served.serve_forever, daemon=True).start()
    port = served.server_address[1]
    monkeypatch.setattr(webapp_setup.app_ports, "listeners", lambda: [])
    try:
        app.make(ports={"port": port})
        running = await webapp_setup.step("a1", "start", check=False)
        assert running.ok and not running.ran and running.value == str(port), running.detail
        stopped = await webapp_setup.stop("a1")
        assert stopped.exit_code is ExitCode.NOT_YET and not stopped.ran
        assert f"served on port {port} by a program Flowpad did not start and cannot stop" in stopped.detail
        assert webapp_setup.health_answers(port)
    finally:
        served.shutdown()
        served.server_close()


@pytest.mark.asyncio
async def test_an_app_whose_folder_is_gone_reserves_no_port(app, tmp_path, monkeypatch):
    """Its row outlives its folder until the index drops it; a ghost must not block a live app."""
    import shutil

    from flow_sdk.builtin.faas.micro_app import WebApp

    live = app.make(ports={"port": _free()})
    ghost = app.make(id="a2", at=tmp_path / "ghost", ports={"port": _free()})
    shutil.rmtree(tmp_path / "ghost")

    async def rows(_query=None):
        return [live, ghost]

    monkeypatch.setattr(WebApp, "get_all", rows)
    assert [row.id for row in await webapp_setup._project_apps("p1")] == [live.id]
    assert await webapp_setup._project_apps(None) == []



@pytest.mark.asyncio
async def test_a_server_that_answers_a_moment_after_its_port_opens_is_up_on_the_first_start(app):
    """A container's published port opens at once and the server behind it answers later: the first
    start must not call that a failure (it did, and the container was left running behind it)."""
    late = (
        f"{sys.executable} -c \"import socket,sys,time,http.server,threading; "
        "p=int(sys.argv[1]); s=socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); "
        "s.bind(('127.0.0.1', p)); s.listen(); time.sleep(1.5); s.close(); "
        "http.server.ThreadingHTTPServer(('127.0.0.1', p), http.server.SimpleHTTPRequestHandler).serve_forever()\" {port}"
    )
    app.make(start_cmd=late)
    started = await webapp_setup.step("a1", "start", check=False)
    assert started.ok and started.ran, started.detail
    assert webapp_setup.health_answers(int(started.value))
