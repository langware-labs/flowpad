"""``flow app open`` decides "is the app already serving" by the one port rule, not by "the port answers".

Real sockets and a real ``python -m http.server``: the CLI used to take ANY listener on the port for the
app and register it — another program, shown as the app.
"""

from __future__ import annotations

import os
import signal
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
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except OSError:
            pass
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
