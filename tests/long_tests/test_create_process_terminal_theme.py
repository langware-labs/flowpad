"""The launch that ``createProcess`` performs must pin the terminal's palette.

``ComputeNode.createProcess`` creates the process AND spawns its PTY in the same
request, so THIS is the call that freezes the worker's command line. The client's
later ``open`` only reattaches and can no longer influence it. A worker launched
here without ``--settings {"theme": …}`` picks its colours from the user's global
Claude theme — usually dark — and paints pale grey/lavender on a light terminal.

Asserts the argv of the REAL spawned worker, not a recorded call argument: the
command line is what the CLI actually reads.
"""

import json

import psutil
import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from tests.test_settings import test_service_config

pytestmark = pytest.mark.skipif(
    not test_service_config.deep_testing,
    reason="Skipping long tests when DEEP_TESTING is disabled",
)


async def _create_visible_process(client, workdir: str, theme: str | None) -> str:
    body: dict = {"context": {"workdir": workdir}, "visible": True}
    if theme is not None:
        body["theme"] = theme
    resp = await client.post("/api/v1/graph/compute_node/@local/createProcess", json=body)
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]["id"]


def _worker_argv(process: AgenticProcess) -> list[str]:
    """argv of the REAL worker this process spawned, found by its session id.

    ``shell.pty_pid`` is the PTY session UUID, not an OS pid, so the worker is
    located by the ``--session-id`` the launch pinned on it — which also proves
    the argv belongs to THIS process and not a neighbouring worker.
    """
    assert process.shell_id, "createProcess did not spawn a shell"
    assert process.session_id, "createProcess did not assign a session id"
    for proc in psutil.process_iter(["cmdline"]):
        argv = proc.info.get("cmdline") or []
        if process.session_id in argv:
            return argv
    raise AssertionError(f"no live worker found for session {process.session_id}")


def _pinned_theme(argv: list[str]) -> str | None:
    if "--settings" not in argv:
        return None
    return json.loads(argv[argv.index("--settings") + 1]).get("theme")


@pytest.mark.asyncio
# do not increase timeout without approval
@pytest.mark.timeout(60)
@pytest.mark.parametrize("theme", ["light", "dark"])
async def test_create_process_pins_terminal_theme(bootstrapped_client, tmp_path, theme):
    """The worker createProcess spawns must carry the requested palette."""
    process_id = await _create_visible_process(bootstrapped_client, str(tmp_path), theme)
    process = await AgenticProcess.get_by_id(process_id)
    try:
        argv = _worker_argv(process)
        assert _pinned_theme(argv) == theme, f"worker launched without the {theme!r} palette pinned; argv={argv}"
    finally:
        await process.close()


@pytest.mark.asyncio
# do not increase timeout without approval
@pytest.mark.timeout(60)
async def test_create_process_without_theme_leaves_worker_unpinned(bootstrapped_client, tmp_path):
    """No theme in the request → no ``--settings``, so non-UI callers (triggers,
    workflows, the recovery sweep) keep the CLI's own default."""
    process_id = await _create_visible_process(bootstrapped_client, str(tmp_path), None)
    process = await AgenticProcess.get_by_id(process_id)
    try:
        assert _pinned_theme(_worker_argv(process)) is None
    finally:
        await process.close()
