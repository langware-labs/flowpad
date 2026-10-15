"""``flow app open`` decides "is the app already serving" by the one port rule, not by "the port answers".

Real sockets and a real ``python -m http.server``: the CLI used to take ANY listener on the port for the
app and register it — another program, shown as the app.
"""

from __future__ import annotations

import socket
import subprocess
import sys

import click
import pytest

from flow_sdk.cli.commands import app_cmd
from flow_sdk.core import app_ports, dev_server

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

START = f"{sys.executable} -m http.server {{port}} --bind 127.0.0.1"


@pytest.fixture
def serve(tmp_path):
    started = []

    def run(folder, port):
        proc = subprocess.Popen(  # noqa: S603
            [sys.executable, "-m", "http.server", str(port), "--bind", "127.0.0.1"],
            cwd=str(folder), start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        started.append(proc)
        assert dev_server.wait_for_port(port, 10)
        return proc

    yield run
    for proc in started:
        dev_server.stop_group(proc.pid)
        proc.wait()


def test_a_free_port_is_where_the_app_will_start(tmp_path):
    port = app_ports.free_port()
    assert app_cmd._where(port, tmp_path, START, "shop") == (port, False)


def test_the_app_already_serving_from_its_folder_is_found_on_the_port_it_listens(tmp_path, serve):
    """Flowpad (or the person) started it on another port than the one the CLI inferred: that is the
    app, and no second server is started on the inferred port."""
    live, inferred = app_ports.free_port(), app_ports.free_port()
    serve(tmp_path, live)
    assert app_cmd._where(inferred, tmp_path, START, "shop") == (live, True)


def test_another_program_on_the_port_is_an_error_that_names_it_never_the_app(tmp_path, serve, capsys):
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    app = tmp_path / "shop"
    app.mkdir()
    port = app_ports.free_port()
    stranger = serve(elsewhere, port)
    with pytest.raises((SystemExit, click.exceptions.Exit)):
        app_cmd._where(port, app, START, "shop")
    said = capsys.readouterr()
    assert f"port {port} is held by another program" in said.out + said.err
    assert f"(pid {stranger.pid})" in said.out + said.err


def test_a_listener_in_this_process_is_another_program_too(tmp_path):
    held = socket.socket()
    held.bind(("127.0.0.1", 0))
    held.listen()
    try:
        with pytest.raises((SystemExit, click.exceptions.Exit)):
            app_cmd._where(held.getsockname()[1], tmp_path, START, "shop")
    finally:
        held.close()


# ── the project's own app is started by the backend, by the one rule ─────────────────────────────


def _project(monkeypatch, *, apps: list[str], started: dict | None = None, in_project: bool = True) -> list:
    calls: list = []
    monkeypatch.setattr(app_cmd, "_project_action_url", lambda action, required=True: f"project/p/{action}" if in_project else None)

    def action(name, body=None):
        calls.append((name, body))
        if name == "app-ports":
            return {"ports": [{"app": app, "process": process} for app in apps for process in ("page", "api")]}
        return {"apps": [started or {"app": apps[0], "ok": True, "port": "3390"}]}

    monkeypatch.setattr(app_cmd, "_project_action", action)
    return calls


def test_open_starts_the_projects_declared_app_through_the_backend_on_its_port(monkeypatch):
    """``flow app open`` used to scan the folder and start its own server on a picked 80xx port, beside
    the page and API the app's ``webapp.json`` declares."""
    calls = _project(monkeypatch, apps=["shop"])
    assert app_cmd._start_declared("shop") == 3390
    assert calls[-1] == ("app-start", {"app": "shop"})


def test_open_with_no_name_takes_the_projects_only_app(monkeypatch):
    _project(monkeypatch, apps=["shop"])
    assert app_cmd._start_declared("") == 3390
    _project(monkeypatch, apps=["shop", "admin"])
    assert app_cmd._start_declared("") is None, "two apps and no name: nothing is guessed"


def test_open_outside_a_project_or_for_another_app_keeps_its_own_discovery(monkeypatch):
    _project(monkeypatch, apps=["shop"], in_project=False)
    assert app_cmd._start_declared("shop") is None
    _project(monkeypatch, apps=["shop"])
    assert app_cmd._start_declared("dashboard") is None


def test_a_declared_app_that_cannot_start_is_an_error_that_says_why(monkeypatch, capsys):
    _project(monkeypatch, apps=["shop"], started={"app": "shop", "ok": False, "detail": "port 3390 is held by another program: java (pid 9)"})
    with pytest.raises((SystemExit, click.exceptions.Exit)):
        app_cmd._start_declared("shop")
    said = capsys.readouterr()
    assert "held by another program: java (pid 9)" in said.out + said.err


def test_a_port_the_backend_placed_is_shown_not_the_apis_from_the_same_folder(tmp_path, serve):
    """The page and its API serve from one folder: a folder search found the API and showed it as the
    app. The port the backend started the page on is the answer."""
    api, page = app_ports.free_port(), app_ports.free_port()
    serve(tmp_path, api)
    assert app_cmd._where(page, tmp_path, START, "shop", placed=True) == (page, True)
    assert app_cmd._where(page, tmp_path, START, "shop")[0] == api, "without it, the API is taken for the page"
