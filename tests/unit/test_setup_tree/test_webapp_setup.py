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
import sys
import time
from types import SimpleNamespace

import pytest

from flow_sdk.builtin import webapp_setup
from flow_sdk.core import dev_server
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode
from flow_sdk.schema.data_spec.webapp_spec import WebappMountSpec

pytestmark = pytest.mark.timeout(20)

SERVER = f"{sys.executable} -m http.server {{port}} --bind 127.0.0.1"


@pytest.fixture
def app(tmp_path, monkeypatch):
    folder = tmp_path / "site"
    folder.mkdir()
    (folder / "index.html").write_text("ok")
    state = SimpleNamespace(endpoint=None, started=[])

    def make(*, install_cmd="", port=None, package=False, start_cmd=SERVER):
        if package:
            (folder / "package.json").write_text("{}")
        serving = {"type": "proxy", "start_cmd": start_cmd, "health": "/", "install_cmd": install_cmd}
        if port:
            serving["port"] = port
        row = SimpleNamespace(
            id="a1", name="site", asset_ref=str(folder), build=".", project_id=None,
            mounts=[WebappMountSpec(serving=serving)], services=[],
        )

        async def by_id(_id):
            return row

        monkeypatch.setattr(webapp_setup, "_app", by_id)
        return row

    async def placed(_app):
        return state.endpoint

    async def keep(_app, mount, port, command):
        state.endpoint = SimpleNamespace(mount="site", backend=SimpleNamespace(type="proxy", port=port))

    real_start = dev_server.start_process

    def start(command, **kw):
        proc, log = real_start(command, **kw)
        state.started.append(proc.pid)
        return proc, log

    monkeypatch.setattr(webapp_setup, "_placed", placed)
    monkeypatch.setattr(webapp_setup, "_keep_route", keep)
    monkeypatch.setattr(dev_server, "start_process", start)
    monkeypatch.setattr(dev_server, "log_dir", lambda: tmp_path / "logs")
    monkeypatch.setattr(dev_server, "owner_dir", lambda: tmp_path / "started")
    state.make, state.folder = make, folder
    yield state
    for pid in state.started:
        try:
            os.killpg(pid, signal.SIGTERM)
        except OSError:
            pass


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
async def test_a_server_the_person_runs_themselves_is_still_found_by_its_health(app):
    """No start of ours ever launched it (``flow app open``, a terminal): there is no process to name."""
    import http.server
    import threading

    own = http.server.ThreadingHTTPServer(("127.0.0.1", 0), http.server.SimpleHTTPRequestHandler)
    threading.Thread(target=own.serve_forever, daemon=True).start()
    try:
        app.make()
        app.endpoint = SimpleNamespace(mount="site", backend=SimpleNamespace(type="proxy", port=own.server_address[1]))
        answer = await webapp_setup.step("a1", "start", check=True)
        assert answer.ok and app.started == []
    finally:
        own.shutdown()
        own.server_close()


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
async def test_an_app_that_is_only_files_has_nothing_to_set_up(app, monkeypatch):
    row = SimpleNamespace(id="a1", name="site", asset_ref=str(app.folder), build=".", project_id=None, mounts=[], services=[])

    async def by_id(_id):
        return row

    monkeypatch.setattr(webapp_setup, "_app", by_id)
    answer = await webapp_setup.step("a1", "start", check=False)
    assert answer.ok and not answer.ran


@pytest.mark.asyncio
async def test_an_unknown_app_or_step_is_not_found(app, monkeypatch):
    async def none(_id):
        return None

    monkeypatch.setattr(webapp_setup, "_app", none)
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
