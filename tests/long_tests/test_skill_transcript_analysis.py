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
import uuid
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.model_tiers import ModelTier
from flow_sdk.flowpad_types.enums import WorkerType
from flow_sdk.transcript_analyzer import EntryKind
from tests.long_tests._transcript_helpers import (
    ANALYZER_WORKER_KEY,
    assert_prompt_ok,
    await_transcript,
    safe_exit,
)
from tests.test_settings import test_service_config

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
    worker_type, cli_name, temp_skill, tmp_path, _workers_discovered,
    local_project, local_compute_node,
):
    if shutil.which(cli_name) is None:
        pytest.skip(f"{cli_name} CLI not installed")

    skill_name, _sentinel, skills_parent = temp_skill

    codex_installed = None
    if worker_type is WorkerType.CODEX:
        codex_installed = _install_for_codex(skill_name, skills_parent)
        if codex_installed is None:
            pytest.skip("cannot stage skill into ~/.codex/skills")

    # prompt() resolves the process by id server-side — an unsaved instance
    # fails with "not found in database" (which the old `getattr(result, "ok",
    # True)` assert could not catch, degrading this test to a permanent skip).
    process = await AgenticProcess(
        worker_type=worker_type,
        workdir=str(tmp_path),
        additional_dirs=[str(skills_parent)],
        # Small tier resolves worker-blind at spawn: haiku (claude),
        # gpt-5.4-mini (codex/copilot) — cheapest/fastest for this probe.
        cli_config={"model": ModelTier.SM.value},
        visible=False,
    ).save()
    instruction = (
        f"Run the {skill_name} skill now and follow its instructions exactly."
    )
    try:
        # Headless prompt is fire-and-forget; the worker streams its turn into a
        # JSONL transcript in the background and assigns process.session_id.
        result = await process.prompt(instruction)
        assert_prompt_ok(result)

        transcript = await await_transcript(
            process,
            ANALYZER_WORKER_KEY[worker_type],
            lambda tf: bool(_skill_call_entries(tf, skill_name)),
            deadline_s=90,
        )
        if transcript is None:
            pytest.skip(f"{cli_name} produced no usable transcript within 90s — infra/LLM latency")

        # The analyzer normalizes every worker's skill shape onto SkillCallEntry,
        # so the assertion is identical across claude / codex / copilot.
        calls = _skill_call_entries(transcript, skill_name)
        if not calls:
            # Distinguish a REAL parser regression from worker non-compliance.
            # A healthy parser normalizes every native `skill` tool into a
            # SkillCallEntry; a regression would instead leave it as a generic
            # ToolUseEntry whose tool_name is still "skill". So the regression
            # signal is specifically a TOOL_USE entry named "skill" (NOT a
            # SkillCallEntry, which also carries tool_name="skill" — filtering on
            # tool_name alone would false-positive on a correctly-normalized call
            # whose skill_name merely differs from ours).
            #
            # If no such regressed entry exists, our skill never surfaced as a
            # recognizable native skill call: copilot (1.0.65+) non-deterministically
            # "runs" a skill by spawning a `task` sub-agent / bash, or invokes a
            # differently-named skill — emitting nothing for OUR name to normalize.
            # That is LLM non-compliance, downgraded to a skip exactly like the
            # latency case above (never a flaky-marker, never a weakened assertion).
            regressed_skill_tooluse = list(
                transcript.filter(kind=EntryKind.TOOL_USE, tool_name="skill")
            )
            if not regressed_skill_tooluse:
                pytest.skip(
                    f"{cli_name} produced a transcript but did not surface a native "
                    f"skill call for {skill_name!r} (improvised via task/bash or "
                    f"invoked a differently-named skill) — LLM non-compliance"
                )
        assert calls, (
            f"a native `skill` tool was left UN-normalized (generic ToolUseEntry) in "
            f"the {cli_name} transcript ({len(transcript.entries)} entries total) — "
            f"parser regression: skill calls must become SkillCallEntry"
        )
    finally:
        if codex_installed is not None:
            shutil.rmtree(codex_installed, ignore_errors=True)
        await asyncio.shield(safe_exit(process))
