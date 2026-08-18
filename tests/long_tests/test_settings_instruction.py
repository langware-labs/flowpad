"""Live cross-worker validation that a process's *settings instruction* is obeyed.

This is the "vibe custom instruction" path: a user sets an instruction like
"Always finish answer with foobar" on an :class:`AgenticProcess`
(``process.instructions``), sends a trivial prompt, and expects the worker to
follow it. The instruction is delivered by three different mechanisms per
vendor (Claude ``--append-system-prompt-file``, Codex ``-c
developer_instructions=``, Copilot ``COPILOT_CUSTOM_INSTRUCTIONS_DIRS`` + file
discovery), so this test runs against claude / codex / copilot to catch a
vendor-specific regression where the instruction never reaches the worker.

Unlike ``test_system_prompt`` (which asserts the model echoes facts *from* the
instruction), this asserts a *behavioral suffix* the instruction demands — the
minimal "hi" prompt gives the model no other reason to emit the marker, so its
presence proves the settings instruction was both delivered and obeyed.

Run:

    DEEP_TESTING=1 uv run pytest tests/long_tests/test_settings_instruction.py -v -s
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import time
import uuid
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.faas.compute_node import ComputeNode
from flow_sdk.flowpad_types.enums import WorkerType
from flow_sdk.transcript_analyzer import AgentTranscriptFile, EntryKind
from flow_sdk.transcript_analyzer.resolver import TranscriptNotFoundError, resolve_session_jsonl
from tests.long_tests._model_tier import small_model_for
from tests.long_tests._transcript_helpers import (
    ANALYZER_WORKER_KEY,
    assert_prompt_ok,
    safe_exit,
)
from tests.test_settings import test_service_config

pytestmark = [
    pytest.mark.skipif(
        not test_service_config.deep_testing,
        reason="Skipping long tests when DEEP_TESTING is disabled",
    ),
    pytest.mark.asyncio,
]

_WORKERS = [
    pytest.param(WorkerType.CLAUDE_CODE, "claude", id="claude"),
    pytest.param(WorkerType.CODEX, "codex", id="codex"),
    pytest.param(WorkerType.COPILOT, "copilot", id="copilot"),
]

# A live turn that couldn't actually run (auth/login/rate-limit) is external
# infra, not an instruction-following regression — the tests skip on these
# rather than red-failing.
_INFRA_ERROR_TOKENS = (
    "prompt error:",
    "not logged in",
    "authenticat",
    "oauth",
    "session expired",
    "could not be refreshed",
    "select login method",
    "rate limit",
)


@pytest.fixture(scope="module")
async def _workers_discovered():
    from flow_sdk.core.capabilities.discovery import ensure_discovered

    await ensure_discovered()


@pytest.fixture(autouse=True)
def _resolve_claude_transcript_from_real_cli_home(monkeypatch):
    """Point the Claude transcript resolver at the *real* ``~/.claude`` the CLI writes to.

    These tests spawn the real worker CLIs under the swapped real ``$HOME`` (see
    the parent conftest's ``_real_home_for_cli_subprocess_tests``). A Claude
    worker therefore writes its session JSONL under the real ``~/.claude/projects``
    (``apply_worker_env`` leaves ``CLAUDE_CONFIG_DIR`` unset for the native root).
    The resolver, though, reads ``get_instance_settings().claude_projects_dir`` —
    pinned at import to the *sandbox* home — so it globs an empty dir and a turn
    that really ran (and obeyed the instruction) looks like it never happened.
    Redirect just the Claude projects dir to where the CLI actually wrote, so
    resolution matches the subprocess. Codex resolves via its own instance dir
    (CLI + resolver agree) and Copilot via ``Path.home()`` at call time, so
    neither needs this — only Claude has the import-time/spawn-time home split.
    Deliberately the narrowest redirect: repointing this at the settings level
    (FLOWPAD_CLAUDE_HOME + reset) would also drag the history indexer/watcher onto
    the real projects tree, which the sandbox split exists to prevent.
    """
    from flow_sdk.transcript_analyzer import resolver

    real_home = Path(os.environ.get("FLOWPAD_PRE_SANDBOX_HOME") or os.path.expanduser("~"))
    monkeypatch.setattr(resolver, "_claude_projects_dir", lambda: real_home / ".claude" / "projects")


def _small_cli_config(worker_type: WorkerType) -> dict:
    # Persist sm for every worker; native Copilot resolves it to vendor auto.
    config = {"permission_mode": "bypassPermissions"}
    model = small_model_for(worker_type)
    if model:
        config["model"] = model
    return config


def _make_marker_and_prompt() -> tuple[str, str]:
    """A unique marker + the settings instruction that demands it as a suffix.

    Nonce-suffixed so a match is unambiguous: the "hi" prompt gives the model no
    path to this exact token except by following the settings instruction.
    """
    marker = f"foobar-{uuid.uuid4().hex[:8]}"
    system_prompt = (
        f"Always finish your answer with the exact token {marker} on its own final line, no matter what is asked."
    )
    return marker, system_prompt


def _assert_assets_materialized(assets, system_prompt: str) -> None:
    """Every vendor's discovery file carries the instruction (delivery evidence)."""
    for rel in (
        "CLAUDE.md",
        "AGENTS.md",
        ".agents",
        ".github/instructions/flowpad.instructions.md",
    ):
        path = assets.os_path / rel
        assert path.exists(), path
        assert system_prompt in path.read_text(encoding="utf-8")


async def _await_and_assert_marker(
    process: AgenticProcess,
    worker_type: WorkerType,
    *,
    cli_name: str,
    marker: str,
    turn_started: float,
    label: str = "",
) -> None:
    """Poll for the marker; skip on no-live-turn / infra error, else assert obedience."""
    body, saw_fresh = await _await_marker(process, worker_type, marker=marker, deadline_s=20, min_mtime=turn_started)
    if not saw_fresh:
        pytest.skip(
            f"{cli_name} wrote no fresh transcript within 20s — no live{label} turn "
            f"(CLI stuck/unauthed, or only a stale session on disk)"
        )
    if any(token in body.lower() for token in _INFRA_ERROR_TOKENS):
        pytest.skip(f"{cli_name} CLI could not complete a live{label} turn: {body[:500]}")
    assert marker in body, (
        f"{cli_name}{label}: settings instruction was not obeyed — marker "
        f"{marker!r} absent from assistant response:\n{body[:1000]}"
    )


@pytest.mark.parametrize("worker_type, cli_name", _WORKERS)
async def test_settings_instruction_is_obeyed(worker_type, cli_name, tmp_path: Path, _workers_discovered):
    if shutil.which(cli_name) is None:
        pytest.skip(f"{cli_name} CLI not installed")

    marker, system_prompt = _make_marker_and_prompt()

    process = AgenticProcess(
        worker_type=worker_type,
        workdir=str(tmp_path),
        visible=False,
        pty_mode=False,
        load_flowpad_assistant=False,
        cli_config=_small_cli_config(worker_type),
    )
    process.instructions = system_prompt

    try:
        turn_started = time.time()
        result = await process.prompt("hi")
        assert_prompt_ok(result)

        # If this fails, delivery (not obedience) is broken.
        assets = process.embedded_assets
        assert assets is not None
        assert str(assets.os_path) in process.additional_dirs
        _assert_assets_materialized(assets, system_prompt)

        await _await_and_assert_marker(
            process, worker_type, cli_name=cli_name, marker=marker, turn_started=turn_started
        )
    finally:
        await asyncio.shield(safe_exit(process))


@pytest.mark.parametrize("worker_type, cli_name", _WORKERS)
async def test_settings_instruction_is_obeyed_pty(
    worker_type, cli_name, tmp_path: Path, bootstrapped_client, _workers_discovered
):
    """Same guarantee as the headless test, but through the interactive PTY/vibe
    transport (``pty_mode=True``).

    This is the path a user actually drives in the app: the instruction assets
    are applied at PTY launch (``agentic_process._perform_open``), the TUI boots,
    and the prompt is submitted through the live PTY — a different call site than
    the headless ``driver.headless_prompt``, so a vendor regression that only
    bites the interactive path shows up here and not in the headless test.
    """
    if shutil.which(cli_name) is None:
        pytest.skip(f"{cli_name} CLI not installed")

    cn = await ComputeNode.get_one({"uname": "local"})
    assert cn, "No @local compute node found"

    marker, system_prompt = _make_marker_and_prompt()

    process = AgenticProcess(
        worker_type=worker_type,
        compute_node_id=f"compute_node-{cn.id}",
        workdir=str(tmp_path),
        visible=True,
        pty_mode=True,
        load_flowpad_assistant=False,
        cli_config=_small_cli_config(worker_type),
    )
    process.instructions = system_prompt
    await process.save()

    try:
        turn_started = time.time()
        # Cold-PTY first-prompt delivery splits on the vendor's TUI, the same
        # ``pty_submits_on_paste`` trait production's write_then_submit keys on.
        # (Each call persists to a reloaded copy without mutating this in-memory
        # object, so re-fetch after to observe the spawned shell/session.)
        if process.driver.pty_submits_on_paste:
            # Claude pastes+submits on boot: seed through the production launch
            # path (prompt() routes a not-yet-running PTY to
            # start_pty(instruction=...)). Typing into Claude *after* boot races
            # its input-ready state — is_running() flips true the instant the
            # shell spawns, but the keystrokes are dropped before the TUI truly
            # accepts input, so a start_pty()+submit() turn silently never runs.
            result = await process.prompt("hi")
            assert getattr(result, "status_code", 200) < 400, result
            process = await AgenticProcess.get_by_id(process.id)
        else:
            # Codex/Copilot are settle-then-Enter TUIs that do NOT auto-submit a
            # seeded launch prompt: boot the PTY, then type+Enter via submit().
            boot = await process.start_pty()
            assert getattr(boot, "status_code", 200) < 400, boot
            process = await AgenticProcess.get_by_id(process.id)
            submitted = await process.submit("hi")
            assert getattr(submitted, "status_code", 200) < 400, submitted
        assert process.shell_id, "PTY worker did not spawn a shell"

        # embedded_assets may not rehydrate on the refetched object, so this is
        # best-effort delivery evidence (the marker assertion is the real gate).
        assets = process.embedded_assets
        if assets is not None:
            _assert_assets_materialized(assets, system_prompt)

        await _await_and_assert_marker(
            process,
            worker_type,
            cli_name=cli_name,
            marker=marker,
            turn_started=turn_started,
            label=" (PTY)",
        )
    finally:
        await asyncio.shield(safe_exit(process))


# --- freshness-aware transcript polling -------------------------------------
# The shared ``_transcript_helpers.resolve_transcript`` has no mtime gate; on a
# shared real ``$HOME`` a leftover session from a prior run would resolve as this
# turn's output. These locals add the ``min_mtime`` freshness check that keeps a
# stale session from masquerading as a fresh, marker-less (regressed) turn.


def _is_fresh(tf: AgentTranscriptFile | None, min_mtime: float) -> bool:
    if tf is None:
        return False
    try:
        return tf.path.stat().st_mtime >= min_mtime
    except OSError:
        return False


def _resolve_transcript(
    process: AgenticProcess, worker_type: WorkerType, min_mtime: float
) -> AgentTranscriptFile | None:
    tf = process._load_transcript()
    if _is_fresh(tf, min_mtime):
        return tf
    session_id = process.session_id
    if not session_id:
        return None
    worker_key = ANALYZER_WORKER_KEY[worker_type]
    try:
        path = resolve_session_jsonl(worker_key, session_id)
    except (TranscriptNotFoundError, ValueError):
        return None
    if path and path.exists():
        tf = AgentTranscriptFile(worker_key, path)
        if _is_fresh(tf, min_mtime):
            return tf
    return None


def _assistant_text(transcript: AgentTranscriptFile) -> str:
    return "\n".join(
        getattr(entry, "text", "")
        for entry in transcript.filter(kind=EntryKind.ASSISTANT_MESSAGE)
        if getattr(entry, "text", "")
    )


def _transcript_dump(transcript: AgentTranscriptFile | None) -> str:
    if transcript is None:
        return ""
    return "\n".join(json.dumps(entry.to_dict(), sort_keys=True, default=str) for entry in transcript.entries)


async def _await_marker(
    process: AgenticProcess,
    worker_type: WorkerType,
    *,
    marker: str,
    deadline_s: float,
    min_mtime: float,
) -> tuple[str, bool]:
    """Return ``(assistant_text, saw_fresh_transcript)`` once *marker* appears.

    ``saw_fresh_transcript`` distinguishes a real instruction-following
    regression (fresh transcript, no marker) from an absent live turn (no fresh
    transcript at all — infra), which the caller downgrades to a skip.
    """
    deadline = time.monotonic() + deadline_s
    last_text = ""
    last_transcript: AgentTranscriptFile | None = None
    saw_fresh = False
    while time.monotonic() < deadline:
        transcript = _resolve_transcript(process, worker_type, min_mtime)
        if transcript is not None:
            saw_fresh = True
            last_transcript = transcript
            last_text = _assistant_text(transcript)
            if marker in last_text:
                return last_text, True
        await asyncio.sleep(2.0)
    return (last_text or _transcript_dump(last_transcript)), saw_fresh
