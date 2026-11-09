"""The box learns the size the hub created it at from the standard box env.

The hub sizes the machine from ITS node row and hands the size over as ``FLOWPAD_NODE_SIZE`` in the env of
every ``flow auth`` command it runs; ``configure-box`` stores it, and the box's ``@local`` node reports it.
Before, the box's record always showed the SDK default ``sm`` -- on an ``lg`` machine too.

A real process on a throwaway instance (``FLOW_HOME`` in tmp): nothing patched, nothing on this machine touched.
"""

import json
import os
import subprocess
import sys

import pytest

pytestmark = pytest.mark.usefixtures("instances_home")


def _configure_box(flow_home, **env) -> dict:
    run_env = {k: v for k, v in os.environ.items() if k != "FLOWPAD_NODE_SIZE"}
    run_env.update(FLOW_HOME=str(flow_home), FLOW_INSTANCE="probe", **env)
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "from flow_sdk.cli.flow_cli import app; app()",
            "auth",
            "configure-box",
            "--cookie-gate=gate-secret",
            "--runtime=sandbox",
        ],
        env=run_env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, result.stderr[-2000:]
    return json.loads(result.stdout.strip().splitlines()[-1])


def _stored(flow_home) -> dict:
    return json.loads((flow_home / "instances" / "probe" / "config.json").read_text())


def test_configure_box_stores_the_size_from_the_box_env(instances_home):
    report = _configure_box(instances_home.flow_home, FLOWPAD_NODE_SIZE="lg")

    assert report["node_size"] == "ok"
    assert _stored(instances_home.flow_home).get("node_size") == "lg"


def test_without_the_env_nothing_is_stored(instances_home):
    """An older hub sends no size: the box keeps reporting the default, and configure-box still succeeds."""
    report = _configure_box(instances_home.flow_home)

    assert report["node_size"] is None
    assert "node_size" not in _stored(instances_home.flow_home)


def test_an_unknown_size_is_reported_not_stored(instances_home):
    report = _configure_box(instances_home.flow_home, FLOWPAD_NODE_SIZE="xxl")

    assert report["node_size"].startswith("error")
    assert "node_size" not in _stored(instances_home.flow_home)
