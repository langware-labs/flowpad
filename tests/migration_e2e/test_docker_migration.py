"""Pytest wrapper for the Docker e2e migration test.

Skipped by default (`@pytest.mark.docker`) so normal `pytest` runs aren't
blocked by Docker requirements. Opt in with:

    DOCKER_E2E=1 uv run pytest tests/migration_e2e/test_docker_migration.py -m docker -v

or just run the shell driver directly:

    bash tests/migration_e2e/run.sh
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

HERE = Path(__file__).parent
RUN_SH = HERE / "run.sh"


pytestmark = pytest.mark.skipif(
    not os.environ.get("DOCKER_E2E"),
    reason="Set DOCKER_E2E=1 to run the Docker e2e migration test "
           "(requires docker, node, uv on host).",
)


@pytest.mark.docker
def test_migration_e2e_docker():
    """Full end-to-end: wheel build → image build → container A-F → host browser hint.

    Shells out to ``run.sh`` and asserts exit 0. On failure, ``run.sh``
    dumps the container logs to stderr so the failure cause is visible
    in pytest output.
    """
    if shutil.which("docker") is None:
        pytest.skip("docker not on PATH")
    if shutil.which("node") is None:
        pytest.skip("node not on PATH (needed for build_ui.py)")

    result = subprocess.run(
        ["bash", str(RUN_SH)],
        timeout=900,
    )
    assert result.returncode == 0, (
        f"run.sh exited {result.returncode} — see captured stderr above for container logs"
    )
