"""`flow app free-dev-port` — the port picker `flow app open` uses, exposed to agents.

Runs without a server: the command only probes local sockets. The band and the
probe are `_choose_static_port`'s (shared with `flow app open` for static apps),
so what this prints is what `open` would have picked.
"""

from __future__ import annotations

import json
import socket

import pytest
from typer.testing import CliRunner

from flow_sdk.cli.commands import app_cmd
from flow_sdk.cli.flow_cli import app

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

runner = CliRunner()


def _bindable(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind(("127.0.0.1", port))
        except OSError:
            return False
        return True


def test_free_dev_port_is_registered():
    result = runner.invoke(app, ["app", "--help"])

    assert result.exit_code == 0
    assert "free-dev-port" in result.output


def test_prints_a_bindable_port_in_the_dev_band():
    result = runner.invoke(app, ["app", "free-dev-port"])

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output.strip().splitlines()[-1])
    assert payload["ok"] is True
    port = payload["port"]
    assert port in app_cmd._STATIC_PORT_RANGE, port
    assert payload["in_range"] is True
    assert _bindable(port), f"picked port {port} is not bindable"


def test_bare_prints_only_the_number():
    result = runner.invoke(app, ["app", "free-dev-port", "--bare"])

    assert result.exit_code == 0, result.output
    port = int(result.output.strip())
    assert port in app_cmd._STATIC_PORT_RANGE


# flowpad:capsule tag
# version: 1
# data:
#   tags:
#     breadcrumb.test.dev_port_picking.rules: FAILING? read this tag's rules first -
#       one probe per invocation, or the backlog is spent
# flowpad:endcapsule tag
def test_skips_a_port_something_is_listening_on():
    # Take the lowest free band port ourselves and LISTEN on it — exactly what a
    # sibling build's `http.server` looks like — then the picker must move on.
    first = int(runner.invoke(app, ["app", "free-dev-port", "--bare"]).output.strip())
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as held:
        held.bind(("127.0.0.1", first))
        held.listen(1)

        result = runner.invoke(app, ["app", "free-dev-port", "--bare"])

        assert result.exit_code == 0, result.output
        picked = int(result.output.strip())
        assert picked != first, f"picked {picked}, which is already listening"
        assert picked in app_cmd._STATIC_PORT_RANGE
        assert _bindable(picked)
