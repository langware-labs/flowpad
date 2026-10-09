"""``webapp_setup.step`` — install, build, start, each with a check; a real process on a real port.

The app is a temp folder whose "dev server" is ``python -m http.server``; its endpoint lookup and the
placement write are stubbed (no DB). What is pinned: install runs once, start comes up and is then
"already running", and a start never adopts a port another program holds.
"""

from __future__ import annotations

import os
import signal
import socket
import sys
from types import SimpleNamespace

import pytest

from flow_sdk.builtin import webapp_setup
from flow_sdk.core import dev_server
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode
from flow_sdk.schema.data_spec.webapp_spec import WebappEndpointSpec

pytestmark = pytest.mark.timeout(20)

SERVER = f"{sys.executable} -m http.server {{port}} --bind 127.0.0.1"


@pytest.fixture
def app(tmp_path, monkeypatch):
    folder = tmp_path / "site"
    folder.mkdir()
    (folder / "index.html").write_text("ok")
    state = SimpleNamespace(endpoint=None, started=[])

    def make(*, install_cmd="", port=None, package=False):
        if package:
            (folder / "package.json").write_text("{}")
        serving = {"type": "proxy", "start_cmd": SERVER, "health": "/", "install_cmd": install_cmd}
        if port:
            serving["port"] = port
        row = SimpleNamespace(
            id="a1", name="site", asset_ref=str(folder), build=".", project_id=None,
            endpoints=[WebappEndpointSpec(name="web", serving=serving)],
        )

        async def by_id(_id):
            return row

        monkeypatch.setattr(webapp_setup, "_app", by_id)
        return row

    async def endpoint(_app, _name):
        return state.endpoint

    async def keep(_app, name, port, command, health, existing):
        state.endpoint = SimpleNamespace(name=name, backend=SimpleNamespace(type="proxy", port=port))

    real_start = dev_server.start_detached

    def start(command, **kw):
        pid, log = real_start(command, **kw)
        state.started.append(pid)
        return pid, log

    monkeypatch.setattr(webapp_setup, "_endpoint", endpoint)
    monkeypatch.setattr(webapp_setup, "_keep_endpoint", keep)
    monkeypatch.setattr(dev_server, "start_detached", start)
    monkeypatch.setattr(dev_server, "log_dir", lambda: tmp_path / "logs")
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


@pytest.mark.asyncio
async def test_an_app_that_is_only_files_has_nothing_to_set_up(app, monkeypatch):
    row = SimpleNamespace(id="a1", name="site", asset_ref=str(app.folder), build=".", project_id=None, endpoints=[])

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

    async def step(webapp, which, *, check):
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
