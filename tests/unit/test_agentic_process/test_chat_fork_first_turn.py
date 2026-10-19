"""A chat fork's first turn forks the parent session instead of starting an empty one.

The chat sends through the ``prompt`` action, which builds its turn with
``_inline_turn_context`` — not ``headless_prompt``. A fork that has no transcript
of its own yet must reach Claude as ``--resume <parent> --fork-session
--session-id <fork>``; a bare ``--session-id <fork>`` opens an empty session and
the parent's conversation is lost.
"""

import uuid

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.flowpad_types.enums import WorkerType
from tests.utils.harness_installed import funding_not_under_test  # noqa: F401 — a fixture

pytestmark = [pytest.mark.asyncio, pytest.mark.usefixtures("funding_not_under_test")]


def _session_flags(argv: list[str]) -> list[str]:
    flags = {"--resume", "--fork-session", "--session-id"}
    return [a for i, a in enumerate(argv) if a in flags or (i and argv[i - 1] in flags - {"--fork-session"})]


async def test_chat_fork_first_turn_resumes_the_parent_and_forks(tmp_path):
    parent_session = str(uuid.uuid4())
    parent = AgenticProcess(
        worker_type=WorkerType.CLAUDE_CODE,
        workdir=str(tmp_path),
        session_id=parent_session,
        pty_mode=False,
    )
    await parent.save()

    forked = await parent.fork_action()
    fork = await AgenticProcess.get_by_id(forked.data["id"])

    # The two steps the ``prompt`` action runs before spawning the turn.
    resumable = fork.driver.has_resumable_session(fork)
    context = await fork._inline_turn_context(resumable=resumable)
    argv, _env, _stdin = fork.driver.stream_worker(fork)._build_spawn(context, "hi")

    assert _session_flags(argv) == [
        "--resume",
        parent_session,
        "--fork-session",
        "--session-id",
        fork.session_id,
    ]
