"""FLOWPAD-1972: the live streamer path must persist ``plan_path`` even though
the ``ExitPlanMode`` tool_use carries no ``planFilePath``.

Claude Code announces the plan file on a ``plan_mode`` ATTACHMENT when the turn
ENTERS plan mode; the later ``ExitPlanMode`` tool_use carries only the ``plan``
prose. The pull path (``transcript/plan``) always had a fallback to that
attachment — the live streamer path did not, so it skipped the entry entirely,
never set ``plan_path``, never broadcast an entity update, and the ribbon's
Open-Plan chip only appeared after a page reload.

These tests enter through ``_process_transcript_entries`` — the method the
streamer's debounce flush actually calls — with a REAL transcript on disk parsed
by the real analyzer, a REAL plan ``.md``, and real DB rows. Nothing about the
plan-detection path itself is stubbed; that path IS the bug.
"""
from __future__ import annotations

import json
import uuid
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.claude_memory_entities import ClaudePlan
from flow_sdk.flowpad_types.enums import WorkerType
from flow_sdk.instance_settings import get_instance_settings, reset_instance_settings

pytestmark = pytest.mark.timeout(60)

_SESSION_ID = "d20fb0c5-b901-4c3e-92ae-d9a6e3cd4b5a"
_ENCODED_PROJECT = "-Users-alice-repo-a"


def _user_line(text: str = "plan me something") -> str:
    return json.dumps({
        "parentUuid": None,
        "isSidechain": False,
        "type": "user",
        "message": {"role": "user", "content": text},
        "uuid": "00000000-0000-4000-8000-0000000000c9",
        "timestamp": "2026-08-11T08:21:30.000Z",
        "userType": "external",
        "entrypoint": "sdk-cli",
        "cwd": "/repo",
        "sessionId": _SESSION_ID,
        "version": "2.1.227",
        "gitBranch": "HEAD",
    })


def _plan_mode_attachment_line(plan_file_path: str) -> str:
    """The entry that actually carries the path (verbatim shape from a real run)."""
    return json.dumps({
        "parentUuid": "00000000-0000-4000-8000-0000000000c9",
        "isSidechain": False,
        "attachment": {
            "type": "plan_mode",
            "reminderType": "full",
            "isSubAgent": False,
            "planFilePath": plan_file_path,
            "planExists": False,
        },
        "type": "attachment",
        "uuid": "00000000-0000-4000-8000-0000000000ca",
        "timestamp": "2026-08-11T08:21:33.099Z",
        "userType": "external",
        "entrypoint": "sdk-cli",
        "cwd": "/repo",
        "sessionId": _SESSION_ID,
        "version": "2.1.227",
        "gitBranch": "HEAD",
    })


def _exit_plan_line(plan_file_path: str | None = None) -> str:
    """``ExitPlanMode`` tool_use. Real Claude sends ONLY ``plan`` — pass
    ``plan_file_path`` to model the Codex-synthesized variant that does carry it."""
    tool_input: dict = {"plan": "## CSV -> JSON CLI Tool\n\nA single-file script."}
    if plan_file_path is not None:
        tool_input["planFilePath"] = plan_file_path
    return json.dumps({
        "parentUuid": "00000000-0000-4000-8000-0000000000ca",
        "isSidechain": False,
        "type": "assistant",
        "message": {
            "model": "claude-sonnet-5",
            "id": "msg_test_plan",
            "type": "message",
            "role": "assistant",
            "content": [{
                "type": "tool_use",
                "id": "toolu_test_plan",
                "name": "ExitPlanMode",
                "input": tool_input,
            }],
            "stop_reason": "tool_use",
        },
        "uuid": "00000000-0000-4000-8000-0000000003e9",
        "timestamp": "2026-08-11T08:23:00.000Z",
        "userType": "external",
        "entrypoint": "sdk-cli",
        "cwd": "/repo",
        "sessionId": _SESSION_ID,
        "version": "2.1.227",
        "gitBranch": "HEAD",
        "slug": "now-produce-a-proper-hashed-ember",
    })


@pytest.fixture
def claude_home(tmp_path: Path, monkeypatch) -> Path:
    """Point the Claude transcript/config root at a tmp dir.

    ``FLOWPAD_CLAUDE_HOME`` is the sanctioned override for exactly this
    (``base_settings._resolve_claude_home``), and ``get_claude_session`` — which
    ``driver.transcript_descriptor`` resolves through — scans that root on disk.
    Redirecting the root is configuration; the resolution code itself runs for real.
    """
    home = tmp_path / ".claude"
    home.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("FLOWPAD_CLAUDE_HOME", str(home))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(home))  # must agree or settings raise
    reset_instance_settings()
    yield home
    # Undo the env FIRST: the settings cache is keyed on (instance, flow_home),
    # neither of which we touched, so resetting while the tmp env is still set
    # would let the next lookup re-cache a claude_home that is about to be
    # deleted, and leak that into unrelated tests.
    monkeypatch.undo()
    reset_instance_settings()


async def _setup(claude_home: Path, *, tool_use_carries_path: bool) -> tuple[AgenticProcess, Path]:
    """Real plan .md + real transcript on disk + real DB rows."""
    settings = get_instance_settings()
    assert settings.claude_projects_dir == claude_home / "projects", (
        f"claude home override did not take: {settings.claude_projects_dir}"
    )

    plans_dir = settings.claude_plans_dir
    plans_dir.mkdir(parents=True, exist_ok=True)
    plan_md = plans_dir / "now-produce-a-proper-hashed-ember.md"
    plan_md.write_text("# CSV -> JSON CLI Tool\n\nThe plan body.\n", encoding="utf-8")

    project_dir = settings.claude_projects_dir / _ENCODED_PROJECT
    project_dir.mkdir(parents=True, exist_ok=True)
    jsonl = project_dir / f"{_SESSION_ID}.jsonl"
    jsonl.write_text(
        "\n".join([
            _user_line(),
            _plan_mode_attachment_line(str(plan_md)),
            _exit_plan_line(str(plan_md) if tool_use_carries_path else None),
        ]) + "\n",
        encoding="utf-8",
    )

    # resolve_plan() needs a ClaudePlan row; its scoped-reindex fallback is
    # covered in tests/unit/test_fs_store/test_transcript_indexer.py. A real row
    # here keeps this test on the path-resolution behaviour under test.
    await ClaudePlan(id=str(uuid.uuid4()), name="Sample plan", asset_ref=str(plan_md)).save()

    ap = AgenticProcess(
        id=str(uuid.uuid4()),
        session_id=_SESSION_ID,
        worker_type=WorkerType.CLAUDE_CODE,
    )
    await ap.save()
    return ap, plan_md


def _entries(ap: AgenticProcess) -> list:
    """The parsed entries the streamer would hand to the flush."""
    transcript = ap._load_transcript()
    assert transcript is not None, "transcript descriptor did not resolve to the tmp JSONL"
    return list(transcript.entries)


@pytest.mark.asyncio
async def test_live_push_sets_plan_path_when_tool_use_omits_plan_file_path(
    claude_home: Path, initialize_test_db,
) -> None:
    """The regression: path only on the attachment, not on the tool_use.

    Before the fix ``entry.plan_file_path`` was ``""``, the guard
    ``isinstance(...) and entry.plan_file_path`` was false, and ``plan_path``
    stayed None — which is exactly why the chip needed a reload.
    """
    ap, plan_md = await _setup(claude_home, tool_use_carries_path=False)
    assert ap.plan_path is None, "precondition: no plan detected yet"

    await ap._process_transcript_entries(_entries(ap))

    assert ap.plan_path == str(plan_md), (
        "live path must resolve the plan path from the plan_mode attachment "
        "when the ExitPlanMode tool_use carries none"
    )
    reloaded = await AgenticProcess.get_by_id(ap.id)
    assert reloaded is not None and reloaded.plan_path == str(plan_md), (
        "plan_path must be PERSISTED — the save is what broadcasts the entity "
        "update the ribbon listens to"
    )


@pytest.mark.asyncio
async def test_live_push_prefers_the_tool_use_path_when_present(
    claude_home: Path, initialize_test_db,
) -> None:
    """Codex synthesizes an ExitPlanMode entry that DOES carry planFilePath.
    The attachment fallback must not displace it."""
    ap, plan_md = await _setup(claude_home, tool_use_carries_path=True)

    await ap._process_transcript_entries(_entries(ap))

    assert ap.plan_path == str(plan_md)


@pytest.mark.asyncio
async def test_plan_path_from_attachments_reads_the_plan_mode_attachment(
    claude_home: Path, initialize_test_db,
) -> None:
    """The shared helper both paths now resolve through."""
    ap, plan_md = await _setup(claude_home, tool_use_carries_path=False)

    assert AgenticProcess.plan_path_from_attachments(ap._load_transcript()) == str(plan_md)
    assert AgenticProcess.plan_path_from_attachments(None) == ""
