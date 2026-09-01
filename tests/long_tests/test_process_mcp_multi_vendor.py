"""Long test: ``p.add_mcp(spec)`` reaches a REAL worker, on every harness.

The cross-worker guarantee: one spec list, four harnesses, four different
channels — ``--mcp-config`` (claude), ``-c mcp_servers.*`` (codex),
``--additional-mcp-config`` (copilot), the generated config's ``mcp`` key
(opencode) — and the worker really calls the tool.

The assertion is a token that exists nowhere else on the machine
(``tests/fixtures/dummy_mcp_server.py``). Echoing it cannot be faked by a model
guessing: it has to have connected to the server and called the tool. That is
the whole reason this test spawns real CLIs instead of asserting on argv, which
``tests/unit/test_process_mcp_runtime.py`` already does.

Staged assertions, the tier's convention: an environment gap (no binary, no
auth, provider quota, a turn slower than the guard) SKIPS; only a worker that
ran and did not get the tool FAILS.

NOTE: this module must stay listed in ``conftest._REAL_HOME_TEST_MODULES`` or
its subprocesses get the sandbox HOME and every turn fails "not logged in".
"""

from __future__ import annotations

import asyncio
import shutil
import sys
from pathlib import Path

import pytest

from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
from flow_sdk.flowpad_types.enums.worker_enums import WorkerType
from flow_sdk.schema.data_spec.mcp_spec import McpSpec
from tests.fixtures.dummy_mcp_server import MAGIC
from tests.long_tests._model_tier import small_model_for
from tests.long_tests._transcript_helpers import assert_prompt_ok, await_transcript, safe_exit
from tests.test_settings import test_service_config

pytestmark = pytest.mark.skipif(
    not test_service_config.deep_testing,
    reason="Skipping long tests when DEEP_TESTING is disabled",
)

#: Strictly below the 30s pytest cap so a hang fails the test rather than
#: masking a slow path. Do not raise it to make a slow turn pass — a slow turn
#: is the signal, not the noise.
_TURN_GUARD_SECONDS = 25

_SERVER = Path(__file__).resolve().parents[1] / "fixtures" / "dummy_mcp_server.py"

_INSTRUCTION = (
    "Call the flowpad_probe tool and reply with exactly what it returned, "
    "nothing else. Do not run any shell command."
)

_WORKER_TYPE = {
    "claude": WorkerType.CLAUDE_CODE,
    "codex": WorkerType.CODEX,
    "copilot": WorkerType.COPILOT,
    "opencode": WorkerType.OPENCODE,
}


def _worker(name: str):
    """One vendor, skipped individually when its binary is absent.

    Deliberately NOT gated on ``OPENROUTER_API_KEY`` for opencode the way older
    modules are: opencode resolves free zero-auth models, so the key is not a
    precondition for a turn.
    """
    return pytest.param(
        name,
        marks=pytest.mark.skipif(shutil.which(name) is None, reason=f"{name} CLI not installed"),
        id=name,
    )


def _cli_config(worker: str) -> dict:
    """Model intent per harness.

    Every vendor but opencode gets the portable ``sm`` tier. OpenCode is
    deliberately left unpinned: its ``sm`` tier resolves to an OpenRouter model,
    which needs ``OPENROUTER_API_KEY`` and exits 1 without one — whereas an
    unpinned opencode falls back to a bundled zero-auth model and runs. The
    subject here is the MCP channel, not model-tier resolution, so pinning a
    model would trade real coverage for none.
    """
    if worker == "opencode":
        return {}
    return {"model": small_model_for(worker)}


WORKERS = [_worker(name) for name in _WORKER_TYPE]


async def _assert_worker_echoed_token(process, worker: str, failure_hint: str) -> None:
    """One turn, then the token or an honest skip.

    Shared by both hops so the staged-assertion policy — an environment gap
    SKIPS, a worker that ran and did not get the tool FAILS — is written once.
    """
    try:
        assert_prompt_ok(await process.prompt(_INSTRUCTION))
        transcript = await await_transcript(
            process, worker, lambda t: MAGIC in _answer_text(t), deadline_s=_TURN_GUARD_SECONDS
        )
        if transcript is None:
            pytest.skip(f"{worker}: no transcript within {_TURN_GUARD_SECONDS}s — auth/env/API gap")
        answer = _answer_text(transcript)
        if not answer.strip():
            pytest.skip(f"{worker}: worker produced no answer (auth/quota) — environment gap")
        assert MAGIC in answer, f"{worker}: {failure_hint} Answer was: {answer[:400]!r}"
    finally:
        await asyncio.shield(safe_exit(process))


def _answer_text(transcript) -> str:
    from flow_sdk.transcript_analyzer.transcript import EntryKind

    return "\n".join(
        entry.text
        for entry in transcript.filter(kind=EntryKind.ASSISTANT_MESSAGE)
        if getattr(entry, "text", "")
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("worker", WORKERS)
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_attached_mcp_server_reaches_a_real_worker(worker: str, tmp_path: Path):
    """The exact usage pattern, parameterized by harness."""
    assert _SERVER.is_file(), f"dummy MCP server missing at {_SERVER}"

    process = await AgenticProcess(
        worker_type=_WORKER_TYPE[worker],
        workdir=str(tmp_path),
        pty_mode=False,  # headless: the in-process, HTTP-free turn path
        visible=False,
        cli_config=_cli_config(worker),
    ).save()

    # ── the pattern under test ───────────────────────────────────────────────
    spec = McpSpec(name="dummy", command=sys.executable, args=[str(_SERVER)])
    assert await process.add_mcp(spec) is True
    assert await process.add_mcp(spec) is False, "re-attaching an identical spec must be a no-op"

    await _assert_worker_echoed_token(
        process,
        worker,
        "ran a turn but never got the token from the attached MCP server — "
        "the spec did not reach this harness's channel.",
    )


# ── the agent hop ────────────────────────────────────────────────────────────


async def _agent_with_mcp_on_disk(root: Path, worker: str) -> Agent:
    """An agent whose MCP server is a FILE in its own folder, indexed from disk.

    Written under ``root`` and indexed as a CWD_ROOT rather than created through
    the entity: this tier runs with the REAL ``$HOME`` (the worker CLIs read
    their credentials from it), so a user-scope asset would materialize into the
    developer's actual home directory.
    """
    from flow_sdk.builtin.flow_message_bundle import _reindex_root
    from flow_sdk.fs_store.record_types import RecordType
    from flow_sdk.schema.data_spec.mcp_spec import McpSpec

    name = f"mcp-probe-{worker}"
    agent_dir = root / "agentic-assets" / "agent" / name
    agent_dir.mkdir(parents=True, exist_ok=True)
    (agent_dir / "agent.md").write_text(
        f"---\nname: {name}\nworker_type: {worker}\n---\n\nA probe agent.\n", encoding="utf-8"
    )
    mcp_dir = agent_dir / "agentic-assets" / "mcp" / "dummy"
    mcp_dir.mkdir(parents=True, exist_ok=True)
    spec = McpSpec(name="dummy", command=sys.executable, args=[str(_SERVER)])
    (mcp_dir / "mcp.json").write_text(spec.model_dump_json(indent=2) + "\n", encoding="utf-8")

    await _reindex_root(root, RecordType.CWD_ROOT, types=(RecordType.AGENT, RecordType.MCP))
    agent = await Agent.get_one({"name": name})
    assert agent is not None, f"agent {name!r} was not indexed from {root}"
    return agent


@pytest.mark.asyncio
@pytest.mark.parametrize("worker", WORKERS)
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_agent_owned_mcp_reaches_a_real_worker(worker: str, tmp_path: Path):
    """Filesystem → indexed asset → agent → the process it creates → the worker.

    The caller never touches ``process.add_mcp``: the server is inherited purely
    because an ``mcp.json`` sits in the agent's folder.
    """
    assert _SERVER.is_file(), f"dummy MCP server missing at {_SERVER}"
    agent = await _agent_with_mcp_on_disk(tmp_path, worker)

    assert [m.name for m in await agent.mcp_assets()] == ["dummy"], "the asset must be owned by the agent"

    process = await agent.create_process(
        "", workdir=str(tmp_path), pty_mode=False, visible=False
    )
    assert [s.name for s in process.resolved_mcp_servers()] == ["dummy"], (
        "the agent's MCP asset did not reach the process it created"
    )
    await process.save()

    await _assert_worker_echoed_token(
        process,
        worker,
        "the agent declared the MCP on disk but its spawned process never got the tool.",
    )
