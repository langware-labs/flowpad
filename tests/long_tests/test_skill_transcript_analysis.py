"""End-to-end: a temp skill is run through an agentic process, then the
transcript analyzer surfaces a normalized ``SkillCallEntry`` — once per worker.

Flow per worker (claude / codex / copilot):
  1. Build a uniquely-named temp skill (SKILL.md) whose body tells the worker
     to invoke it and emit a token.
  2. Make it discoverable to the worker using the plain SDK surface — the skill
     lives under a temp ``.claude/skills`` tree handed to the process via
     ``additional_dirs`` (no hand-rolled absolute paths in the test body).
  3. Run a one-shot headless prompt through ``AgenticProcess``.
  4. Load the transcript through the analyzer WITHOUT naming a path
     (``process._load_transcript()`` resolves the descriptor via the driver).
  5. Assert the analyzer yields a ``SkillCallEntry`` for our skill. The three
     workers expose skills differently (Claude/Copilot native ``Skill`` tool;
     Codex's ``SKILL.md`` file-load) but each parser normalizes onto the one
     ``EntryKind.SKILL_CALL`` entry, so the assertion is identical for all.

Requires:
  - DEEP_TESTING=true
  - the worker's CLI on PATH and authenticated (real ``$HOME`` — this module is
    in ``_REAL_HOME_TEST_MODULES`` in conftest so the CLI inherits credentials).

LLM compliance is non-deterministic; an Anthropic/worker API timeout is
downgraded to a skip by the conftest report hook.
"""

import asyncio
import shutil
import time
import uuid
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.flowpad_types.enums import WorkerType
from flow_sdk.transcript_analyzer import AgentTranscriptFile, EntryKind
from flow_sdk.transcript_analyzer.resolver import (
    TranscriptNotFoundError,
    resolve_session_jsonl,
)
from tests.test_settings import test_service_config

# Analyzer/resolver worker key per WorkerType (the analyzer speaks "claude",
# not "claude_code").
_ANALYZER_NAME = {
    WorkerType.CLAUDE_CODE: "claude",
    WorkerType.CODEX: "codex",
    WorkerType.COPILOT: "copilot",
}

pytestmark = [
    pytest.mark.skipif(
        not test_service_config.deep_testing,
        reason="Skipping long tests when DEEP_TESTING is disabled",
    ),
]


@pytest.fixture(scope="module")
async def _workers_discovered():
    """Run one capability discovery sweep so the drivers can resolve their CLI
    binaries (the server does this at boot; tests must trigger it explicitly)."""
    from flow_sdk.core.capabilities.discovery import ensure_discovered

    await ensure_discovered()


# ── workers under test ───────────────────────────────────────────────────────
# Each entry is (worker_type, cli_executable). The cli is used both to skip when
# it isn't installed and — for codex — to locate its global skills dir.
_WORKERS = [
    pytest.param(WorkerType.CLAUDE_CODE, "claude", id="claude"),
    pytest.param(WorkerType.CODEX, "codex", id="codex"),
    pytest.param(WorkerType.COPILOT, "copilot", id="copilot"),
]


def _write_skill(root: Path, name: str, sentinel: str) -> Path:
    """Create ``<root>/.claude/skills/<name>/SKILL.md`` and return the skills root."""
    skill_dir = root / ".claude" / "skills" / name
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text(
        f"---\n"
        f"name: {name}\n"
        f"description: Test probe skill. Use this whenever asked to run the {name} skill.\n"
        f"---\n\n"
        f"# {name}\n\n"
        f"When this skill runs, reply with exactly this token on its own line:\n\n"
        f"{sentinel}\n",
        encoding="utf-8",
    )
    return root / ".claude" / "skills"


@pytest.fixture
def temp_skill(tmp_path):
    """A uniquely-named temp skill plus the discovery root to mount.

    Yields ``(skill_name, sentinel, skills_parent)`` where ``skills_parent`` is a
    directory containing ``.claude/skills/<skill_name>/`` — handed to the process
    via ``additional_dirs``.
    """
    suffix = uuid.uuid4().hex[:8]
    skill_name = f"transcript-probe-{suffix}"
    sentinel = f"SKILL_RAN_{suffix.upper()}"
    skills_parent = tmp_path / "skill_mount"
    _write_skill(skills_parent, skill_name, sentinel)
    yield skill_name, sentinel, skills_parent


def _install_for_codex(skill_name: str, skills_parent: Path) -> Path | None:
    """Codex only discovers skills from ``~/.codex/skills``; mirror ours there.

    Returns the installed path (for cleanup) or None if the home dir is absent.
    Uses ``Path.home()`` so it tracks the real-HOME swap applied by conftest.
    """
    src = skills_parent / ".claude" / "skills" / skill_name
    codex_skills = Path.home() / ".codex" / "skills"
    try:
        codex_skills.mkdir(parents=True, exist_ok=True)
    except OSError:
        return None
    dest = codex_skills / skill_name
    shutil.rmtree(dest, ignore_errors=True)
    shutil.copytree(src, dest)
    return dest


def _skill_call_entries(transcript, skill_name: str) -> list:
    """Official skill entries for ``skill_name`` from the analyzer.

    Every worker's parser normalizes its own skill shape onto a single
    ``SkillCallEntry`` (Claude/Copilot native ``Skill`` tool-use; Codex's
    ``SKILL.md`` file-load), so this is worker-agnostic: filter the dedicated
    kind and match the skill name.
    """
    return [
        e
        for e in transcript.filter(kind=EntryKind.SKILL_CALL)
        if getattr(e, "skill_name", "") == skill_name
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("worker_type, cli_name", _WORKERS)
# do not increase timeout without approval
@pytest.mark.timeout(120)
async def test_skill_usage_visible_in_transcript(
    worker_type, cli_name, temp_skill, tmp_path, _workers_discovered
):
    if shutil.which(cli_name) is None:
        pytest.skip(f"{cli_name} CLI not installed")

    skill_name, _sentinel, skills_parent = temp_skill

    codex_installed = None
    if worker_type is WorkerType.CODEX:
        codex_installed = _install_for_codex(skill_name, skills_parent)
        if codex_installed is None:
            pytest.skip("cannot stage skill into ~/.codex/skills")

    process = AgenticProcess(
        worker_type=worker_type,
        workdir=str(tmp_path),
        additional_dirs=[str(skills_parent)],
        visible=False,
    )
    instruction = (
        f"Run the {skill_name} skill now and follow its instructions exactly."
    )
    try:
        # Headless prompt is fire-and-forget; the worker streams its turn into a
        # JSONL transcript in the background and assigns process.session_id.
        result = await process.prompt(instruction)
        assert getattr(result, "ok", True), f"prompt failed: {result}"

        transcript = await _await_transcript_with_skill(
            process, worker_type, skill_name, deadline_s=90
        )
        if transcript is None:
            pytest.skip(f"{cli_name} produced no usable transcript within 90s — infra/LLM latency")

        # The analyzer normalizes every worker's skill shape onto SkillCallEntry,
        # so the assertion is identical across claude / codex / copilot.
        calls = _skill_call_entries(transcript, skill_name)
        assert calls, (
            f"no SkillCallEntry for {skill_name!r} in the {cli_name} transcript "
            f"({len(transcript.entries)} entries total)"
        )
    finally:
        if codex_installed is not None:
            shutil.rmtree(codex_installed, ignore_errors=True)
        await asyncio.shield(_safe_exit(process))


def _resolve_transcript(process, worker_type) -> AgentTranscriptFile | None:
    """Path-free transcript load, worker-agnostic.

    Prefers the driver's own resolver (``process._load_transcript()``) — it knows
    each worker's native location (e.g. codex headless tees into the process
    record dir, not ``~/.codex/sessions``). Falls back to the analyzer's
    session resolver, which reads ``Path.home()`` live and so survives the
    conftest HOME swap when the in-process indexer cache is anchored to the
    sandbox HOME (the claude path under pytest).
    """
    tf = process._load_transcript()
    if tf is not None:
        return tf
    session_id = process.session_id
    if not session_id:
        return None
    worker_key = _ANALYZER_NAME[worker_type]
    try:
        path = resolve_session_jsonl(worker_key, session_id)
    except (TranscriptNotFoundError, ValueError):
        return None
    if path and path.exists():
        return AgentTranscriptFile(worker_key, path)
    return None


async def _await_transcript_with_skill(process, worker_type, skill_name, deadline_s):
    """Poll until the run's transcript shows the SkillCallEntry (or deadline lapses)."""
    deadline = time.monotonic() + deadline_s
    last: AgentTranscriptFile | None = None
    while time.monotonic() < deadline:
        tf = _resolve_transcript(process, worker_type)
        if tf is not None:
            last = tf
            if _skill_call_entries(tf, skill_name):
                return tf
        await asyncio.sleep(2.0)
    return last


async def _safe_exit(process: AgenticProcess) -> None:
    try:
        await process.exit()
    except Exception:
        pass
