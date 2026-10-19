"""A launched dev server is told to bind loopback: it is reached through this machine's door, never directly."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from flow_sdk.core import dev_server

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


def test_start_process_binds_the_server_to_loopback_by_convention(tmp_path, monkeypatch):
    monkeypatch.setattr(dev_server, "log_dir", lambda: tmp_path / "logs")
    script = tmp_path / "env.py"
    script.write_text("import os; print(os.environ['HOST'], os.environ['PORT'])")
    proc, log_file = dev_server.start_process(f"{sys.executable} {script}", cwd=tmp_path, port=4321, name="probe")
    proc.wait(timeout=20)
    assert Path(log_file).read_text().split() == [dev_server.LOOPBACK_HOST, "4321"]


def _no_connect(*_a, **_k):
    raise AssertionError("a port the socket table answers for is never connected to")


def test_a_port_the_socket_table_lists_is_answered_without_connecting(monkeypatch):
    """Windows retries a connect to a closed port until its timeout, and one such connect never returned:
    where the table can be read, it is the answer."""
    monkeypatch.setattr(dev_server.socket, "create_connection", _no_connect)
    monkeypatch.setattr(dev_server, "loopback_status", _no_connect)
    monkeypatch.setattr(dev_server, "_listed", lambda port: False)
    assert not dev_server.port_open(4321)
    assert not dev_server.loopback_answers(4321, timeout=2)
    monkeypatch.setattr(dev_server, "_listed", lambda port: True)
    assert dev_server.port_open(4321)


def test_where_the_table_cannot_be_read_a_connect_is_the_probe(monkeypatch):
    import socket

    monkeypatch.setattr(dev_server, "_listed", lambda port: None)
    with socket.socket() as server:
        server.bind((dev_server.LOOPBACK_HOST, 0))
        server.listen()
        port = server.getsockname()[1]
        assert dev_server.port_open(port)
    assert not dev_server.port_open(port)


def test_the_table_lists_a_real_listener_on_a_loopback():
    import socket

    with socket.socket() as server:
        server.bind((dev_server.LOOPBACK_HOST, 0))
        server.listen()
        port = server.getsockname()[1]
        if dev_server._listed(port) is None:
            pytest.skip("this user cannot read the whole socket table here (macOS)")
        assert dev_server._listed(port)
    assert dev_server._listed(port) is False
