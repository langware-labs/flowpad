"""Long-running tests for AgenticProcess watch mechanism.

Two backends are tested with the same watch() API:
  - FILE: watchfiles-based, tails Claude transcript JSONL for new entries
  - WEBSOCKET: connects to ws://localhost:9007/api/watch/transcript, streams
    the same JSONL entries server-side (requires a running server at localhost:9007)

Both backends receive the same transcript entry dicts and use the same filter.

Run manually:
    python -m pytest tests/long_tests/test_agentic_process_watch.py -v -s
"""

import socket

import pytest
from tests.test_settings import test_service_config

pytestmark = pytest.mark.skipif(
    not test_service_config.deep_testing,
    reason="Skipping long tests when DEEP_TESTING is disabled",
)

from flow_sdk.domain.agentic_process import AgenticProcess, WorkerType
from flow_sdk.domain.watcher import WatchType, watch


def _server_running(host: str = "localhost", port: int = 9007) -> bool:
    try:
        with socket.create_connection((host, port), timeout=1):
            return True
    except OSError:
        return False


@pytest.mark.asyncio
@pytest.mark.timeout(180)
@pytest.mark.flaky(reruns=1, reruns_delay=5)
async def test_watch_file_user_prompt():
    """FILE watcher fires when a 'user' transcript entry appears in the JSONL."""
    received = []
    watcher = watch(
        WatchType.FILE,
        lambda e: e.get("type") == "user",
        received.append,
    )

    process = AgenticProcess(workerType=WorkerType.CLAUDE)
    process.start(watcher=watcher)
    process.prompt("Create a text file named hello.txt with the content 'Hello World'.")

    await watcher.wait_for_event(timeout=60)
    assert len(received) >= 1
    assert received[0]["type"] == "user"

    watcher.stop()
    await process.waitForIdle(timeout=150)


@pytest.mark.asyncio
@pytest.mark.timeout(180)
async def test_watch_ws_user_prompt():
    """WEBSOCKET watcher fires when a 'user' transcript entry is streamed from the server.

    Requires a running server at localhost:9007 (uv run -m flow_sdk.server.run).
    """
    if not _server_running():
        pytest.skip("Server not running at localhost:9007 — start it with: uv run -m flow_sdk.server.run")
    received = []
    watcher = watch(
        WatchType.WEBSOCKET,
        lambda e: e.get("type") == "user",
        received.append,
    )

    process = AgenticProcess(workerType=WorkerType.CLAUDE)
    process.start(watcher=watcher)
    process.prompt("Create a text file named hello.txt with the content 'Hello World'.")

    await watcher.wait_for_event(timeout=30)
    assert len(received) >= 1
    assert received[0]["type"] == "user"

    watcher.stop()
    await process.waitForIdle(timeout=90)
