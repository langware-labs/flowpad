"""A codex sub-agent rollout must be distinguishable from a real session.

Codex writes a rollout JSONL for every sub-agent thread it spawns, in the same
``$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<thread_id>.jsonl`` shape as a
top-level session. The only thing separating the two is the ``session_meta``
header: a sub-agent carries ``thread_source: "subagent"`` (plus
``parent_thread_id`` / ``source.subagent``), and its ``session_id`` field names
the PARENT while ``id`` names itself.

``extract_codex_session_from_path`` reads ``id``/``cwd``/``cli_version``/
``originator`` out of that header and nothing else, so both kinds produce an
indistinguishable record. Every caller — the Chats list and
``_resolve_session_record`` behind ``terminals/get_by_worker_id`` — therefore
offers sub-agent threads as resumable sessions. Codex refuses them:

    Error: Failed to resume session from .../rollout-...jsonl:
    thread/resume failed during TUI bootstrap: thread/resume failed:
    cannot resume an unloaded multi-agent v2 sub-agent through its parent;
    resume the parent first, or use thread/read to inspect it (code -32600)

so the worker exits 1 immediately and the process start latch retries it.

The headers below are the real field shape taken verbatim from two rollouts on
disk (the oversized ``base_instructions`` / ``context_window`` blobs, which no
code under test reads, are omitted).
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import AgenticProcessContextKey
from flow_sdk.builtin.agentic_process.cli_drivers.codex.session_history import find_latest_codex_session_jsonl
from flow_sdk.builtin.agentic_process.transcript_subscriber import _route_to_ap
from flow_sdk.builtin.process_lifecycle import ProcessStatus
from flow_sdk.flowpad_types.enums import WorkerType
from flow_sdk.fs_store.indexer.functions.codex_sessions import get_codex_session
from flow_sdk.instance_settings import get_instance_settings, reset_instance_settings
from flow_sdk.transcript_analyzer import AgentTranscriptFile

PARENT_ID = "01a073f4-c4d4-7a23-885a-0b1ad3f67a06"
SUBAGENT_ID = "01a07405-7431-7331-bfd3-d8541e8eb7b9"
CWD = "/Users/alice/Documents/dev/flowpad-oss"


def _user_meta() -> dict:
    return {
        "timestamp": "2026-09-05T23:44:02.717Z",
        "ordinal": 0,
        "type": "session_meta",
        "payload": {
            "session_id": PARENT_ID,
            "id": PARENT_ID,
            "timestamp": "2026-09-05T23:43:36.183Z",
            "cwd": CWD,
            "originator": "codex-tui",
            "cli_version": "0.153.4",
            "source": "cli",
            "thread_source": "user",
            "model_provider": "openai",
            "history_mode": "paginated",
        },
    }


def _subagent_meta() -> dict:
    return {
        "timestamp": "2026-09-06T00:01:49.678Z",
        "ordinal": 0,
        "type": "session_meta",
        "payload": {
            # NOTE: session_id names the PARENT; id names this sub-agent.
            "session_id": PARENT_ID,
            "id": SUBAGENT_ID,
            "forked_from_id": PARENT_ID,
            "parent_thread_id": PARENT_ID,
            "timestamp": "2026-09-06T00:01:49.654Z",
            "cwd": CWD,
            "originator": "codex-tui",
            "cli_version": "0.153.4",
            "source": {
                "subagent": {
                    "thread_spawn": {
                        "parent_thread_id": PARENT_ID,
                        "depth": 1,
                        "agent_path": "/root/phase1_fixer",
                        "agent_nickname": "Chandrasekhar",
                        "agent_role": None,
                    }
                }
            },
            "thread_source": "subagent",
            "agent_nickname": "Chandrasekhar",
            "agent_path": "/root/phase1_fixer",
            "model_provider": "openai",
            "history_mode": "paginated",
            "subagent_history_start_ordinal": 13,
            "multi_agent_version": "v2",
        },
    }


def _write_rollout(day_dir: Path, stamp: str, thread_id: str, meta: dict) -> Path:
    day_dir.mkdir(parents=True, exist_ok=True)
    path = day_dir / f"rollout-{stamp}-{thread_id}.jsonl"
    path.write_text(json.dumps(meta) + "\n", encoding="utf-8")
    return path


@pytest.fixture()
def codex_sessions(tmp_path, monkeypatch):
    """A real $CODEX_HOME holding one user session and one sub-agent rollout."""
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "codex"))
    reset_instance_settings()
    day = get_instance_settings().codex_sessions_dir / "2026" / "09" / "06"
    _write_rollout(day, "2026-09-05T23-43-36", PARENT_ID, _user_meta())
    _write_rollout(day, "2026-09-06T03-01-49", SUBAGENT_ID, _subagent_meta())
    yield
    reset_instance_settings()


def test_codex_subagent_rollout_is_not_offered_as_a_session(codex_sessions):
    """A sub-agent rollout must not resolve as a resumable codex session.

    The inline guard on the parent keeps the fix honest: returning ``None`` for
    everything would silence the bug and break every real session.
    """
    assert get_codex_session(PARENT_ID) is not None, "real sessions must still resolve"

    assert get_codex_session(SUBAGENT_ID) is None, (
        "sub-agent rollout is offered as a resumable session; codex rejects "
        "`resume` on it with 'cannot resume an unloaded multi-agent v2 "
        "sub-agent through its parent' and the worker exits 1"
    )


# ── Adoption: an unprompted process must not take a sibling's thread ─────────
#
# Prod 2026-10-15: process B was opened in the same cwd as process A and never
# prompted, so it had no rollout. A spawned a sub-agent; its rollout announced
# itself, the transcript subscriber asked every id-less codex process to adopt,
# and B's cwd + launch-time guess picked the sub-agent. Every recovery of B then
# ran ``codex resume <sub-agent>`` and exited 1.

B_LAUNCH = "2026-09-05T23:50:00Z"  # after the parent began, before the sub-agent


def _running_codex(started_at: str = B_LAUNCH, **kwargs):
    return AgenticProcess(
        id=str(uuid.uuid4()),
        worker_type=WorkerType.CODEX,
        workdir=CWD,
        visible=True,
        status=ProcessStatus.RUNNING.value,
        context_data={AgenticProcessContextKey.WORKER_STARTED_AT.value: started_at},
        **kwargs,
    )


async def _seed(idle_started_at: str = B_LAUNCH) -> AgenticProcess:
    """A owns the parent session; return the id-less sibling B, both saved and running."""
    owner = _running_codex(session_id=PARENT_ID)
    await owner._db.save(owner)
    idle = _running_codex(started_at=idle_started_at)
    await idle._db.save(idle)
    return idle


def test_cwd_guess_never_picks_a_subagent_rollout(codex_sessions):
    """The only rollout newer than the launch is a sub-agent: there is no session to find."""
    assert find_latest_codex_session_jsonl(cwd=CWD, started_at=B_LAUNCH) is None


async def test_unprompted_process_does_not_adopt_a_siblings_subagent(codex_sessions, initialize_test_db):
    """Drive the subscriber the FSOp watcher calls, with the sub-agent rollout's real entries."""
    idle = await _seed()

    rollout = next(get_instance_settings().codex_sessions_dir.rglob(f"*-{SUBAGENT_ID}.jsonl"))
    entries = AgentTranscriptFile("codex", rollout).entries

    await _route_to_ap(SUBAGENT_ID, rollout, entries)

    reloaded = await AgenticProcess.get_by_id(idle.id)
    assert not reloaded.session_id, f"idle process adopted {reloaded.session_id}"


async def test_process_never_adopts_a_session_another_process_owns(codex_sessions, initialize_test_db):
    """Even a top-level rollout is not ours when a sibling already owns it."""
    idle = await _seed(idle_started_at="2026-09-05T23:43:00Z")  # before the parent: the guess reaches it

    assert await idle.adopt_discovered_session() is None
    assert not idle.session_id


def test_stamped_subagent_id_launches_fresh(codex_sessions):
    """A row already poisoned with a sub-agent id must not ``resume`` it."""
    proc = _running_codex(session_id=SUBAGENT_ID)

    assert not proc.driver.has_resumable_session(proc)
    cmd = proc.driver.cli_options(proc)
    assert cmd.session_id is None
    assert proc.session_id is None
