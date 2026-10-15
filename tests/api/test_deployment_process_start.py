"""A local deployment starts: its command, typed into its own terminal, runs its file.

The terminal is the machine's real shell (PowerShell on Windows, the user's shell elsewhere), so the
typed line must be one that shell runs — FLOWPAD-2255: a POSIX-quoted line never ran in PowerShell.
"""
from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin import deployment_process
from flow_sdk.builtin.deployment import Deployment
from flow_sdk.builtin.shell import Shell

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


@pytest.mark.asyncio
async def test_a_started_local_deployment_runs_its_file_in_its_terminal(bootstrapped_client, tmp_path):
    loop = tmp_path / "loop.py"
    loop.write_text("import time\ntime.sleep(25)\n")
    row = Deployment(
        name=f"start-{uuid.uuid4().hex[:6]}",
        parent_type_id=f"project-{uuid.uuid4()}",
        target={"provider": "local", "scope": "machine", "location": "here"},
        snippet=str(loop),
    )
    await row.save()
    try:
        await deployment_process.start(row)

        shell = await Shell.find_belonging_to(f"deployment:{row.id}")
        typed = (await shell.read()).decode(errors="replace")
        assert deployment_process.alive(row), f"the typed command never ran the deployment's file:\n{typed}"
    finally:
        deployment_process.stop(row)
        await deployment_process.close_shell(row)
        await row.delete()
