"""Manual long-running tests for AgenticProcess end-to-end with the Codex worker.

Mirrors ``tests/long_tests/test_agentic_process.py`` but uses
``WorkerType.CODEX`` so the same lifecycle / transcript / sub-agent surface is
exercised against ``codex exec --json`` instead of ``claude -p``.

NOT executed by the standard pytest suite (no conftest discovery here).
Run manually:
    python -m pytest tests/long_tests/test_codex.py -v -s

Requires the ``codex`` CLI in PATH (``npm i -g @openai/codex``) and a logged-in
codex auth (``codex login``).
"""

import json
from pathlib import Path

import pytest

from flow_sdk.responses import ApiResponse, ApiSuccessResponse
from tests.test_settings import test_service_config

pytestmark = [
    pytest.mark.skipif(
        not test_service_config.deep_testing,
        reason="Skipping long tests when DEEP_TESTING is disabled",
    )
]

from flow_sdk.fs_records.agent_record import AgentRecord as Agent
from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.status_predicates import is_ready_for_input
from flow_sdk.flowpad_types.enums import WorkerType

SAMPLE_SESSION = (
    "Session description: The user asked Codex to fix a bug where the wrong variable "
    "name was used in a Python function. Codex initially misread the variable name and "
    "made an incorrect fix, then corrected itself after the user pointed out the error. "
    "The session ended with the correct fix applied."
)


def _codex_session_files() -> set[str]:
    """Return file names under ``~/.codex/sessions/`` (recursive).

    The codex worker runs with ``--ephemeral`` so the set should NOT grow
    across a single test — analogous to the Claude test's
    ``_agentic_project_dirs`` invariant.
    """
    sessions_root = Path.home() / ".codex" / "sessions"
    if not sessions_root.is_dir():
        return set()
    return {p.name for p in sessions_root.rglob("rollout-*.jsonl")}


def _fmt_entry(entry: dict) -> str:
    """Format a codex transcript entry for console output."""
    t = entry.get("type", "?")
    if t == "item.completed":
        item = entry.get("item") or {}
        itype = item.get("type")
        if itype == "agent_message":
            return (item.get("text") or "")[:120].replace("\n", " ")
        if itype == "command_execution":
            cmd = (item.get("command") or "")[:80]
            return f"[shell] {cmd} (exit={item.get('exit_code')})"
        if itype == "file_change":
            changes = item.get("changes") or []
            return f"[file_change] {len(changes)} change(s)"
    if t == "item.started":
        item = entry.get("item") or {}
        return f"[started: {item.get('type')}]"
    if t == "thread.started":
        return f"thread_id={entry.get('thread_id')}"
    if t == "turn.completed":
        usage = entry.get("usage") or {}
        return f"[turn done] in={usage.get('input_tokens')} out={usage.get('output_tokens')}"
    return ""


@pytest.mark.asyncio
@pytest.mark.timeout(180)
@pytest.mark.flaky(reruns=2, reruns_delay=5)
async def test_codex_process_hello_world(local_project, local_compute_node):
    assert local_compute_node is not None
    sessions_before = _codex_session_files()

    process = await AgenticProcess(workerType=WorkerType.CODEX).save()
    assert is_ready_for_input(process) is False

    result: ApiResponse = await process.prompt(
        "Create a text file named hello.txt with the content 'Hello World'."
    )
    assert isinstance(result, ApiSuccessResponse)
    assert is_ready_for_input(process) is False

    async for entry in process.stream_transcript(timeout=120):
        t = entry.get("type", "?")
        detail = _fmt_entry(entry)
        print(f"  [{t}] {detail}" if detail else f"  [{t}]")

    assert is_ready_for_input(process) is True

    assert process.workdir, "process.workdir should be set after prompt()"
    workdir = Path(process.workdir)
    hello = workdir / "hello.txt"
    assert hello.exists(), f"hello.txt not found in workdir {workdir}"
    assert "hello" in hello.read_text().lower()

    # ``--ephemeral`` should keep ~/.codex/sessions/ untouched.
    new_sessions = _codex_session_files() - sessions_before
    assert not new_sessions, (
        f"New session files appeared in ~/.codex/sessions/ despite --ephemeral: {new_sessions}"
    )

    # ── get-history action: codex transcript should be readable through the
    #    same server action shape the Claude path uses.
    from flow_sdk.builtin.agentic_workers.codex_worker import (
        load_session_history as codex_load_session_history,
    )

    assert process.session_id, "process.session_id must be set after prompt completes"

    direct_history = codex_load_session_history(process.session_id, process_id=process.id)
    assert direct_history, (
        f"codex load_session_history returned empty for session {process.session_id}"
    )
    roles = {item.attributes.get("role") for item in direct_history if item.attributes}
    assert "assistant" in roles, f"expected an assistant entry in history, got roles={roles}"

    action_resp = await process.get_history_action()
    assert isinstance(action_resp, ApiSuccessResponse), (
        f"expected ApiSuccessResponse, got {type(action_resp).__name__}"
    )
    data = action_resp.data or {}
    assert data.get("session_id") == process.session_id
    assert data.get("count") == len(direct_history)
    history_items = data.get("history") or []
    assert history_items, "server action returned empty history"
    first = history_items[0]
    for key in ("flow_value", "attributes", "index", "created_time"):
        assert key in first, f"missing {key!r} in history item: {first}"


@pytest.mark.asyncio
@pytest.mark.timeout(180)
@pytest.mark.flaky(reruns=2, reruns_delay=5)
async def test_codex_process_classify(local_project, local_compute_node):
    process = await AgenticProcess(workerType=WorkerType.CODEX).save()
    await process.prompt(
        "Run the following bash command exactly as written — do NOT interpret or paraphrase:\n"
        "\n"
        "cat > classification.json << 'JSONEOF'\n"
        '{"category": "code", "title": "Hello World Python script", "command": "/code", "confidence": 0.95}\n'
        "JSONEOF\n"
        "\n"
        "Then verify the file exists with: cat classification.json"
    )

    async for entry in process.stream_transcript(timeout=120):
        t = entry.get("type", "?")
        detail = _fmt_entry(entry)
        print(f"  [{t}] {detail}" if detail else f"  [{t}]")

    assert is_ready_for_input(process) is True

    assert process.workdir, "process.workdir should be set after prompt()"
    workdir = Path(process.workdir)
    classification_file = workdir / "classification.json"
    assert classification_file.exists(), f"classification.json not found in {workdir}"

    data = json.loads(classification_file.read_text())
    assert "category" in data, f"'category' missing from: {data}"
    assert "title" in data, f"'title' missing from: {data}"
    assert "command" in data, f"'command' missing from: {data}"
    assert "confidence" in data, f"'confidence' missing from: {data}"
    assert isinstance(data["confidence"], (int, float))
    assert 0.0 <= data["confidence"] <= 1.0


@pytest.mark.asyncio
# NOTE: do NOT increase timeout or mark as flaky — these tests must pass within the global 30s limit
async def test_codex_process_clock_agent(local_project, local_compute_node):
    agent = Agent(
        name="the-clock-agent",
        description="Returns the current timestamp. Use when asked for the current time.",
        prompt='Run `date -u +"%Y-%m-%dT%H:%M:%SZ"` and write the result to clock.txt.',
    )
    process = await AgenticProcess(workerType=WorkerType.CODEX).save()
    process.load_embedded_agent(agent)
    assert "the-clock-agent" in process.cmd_line, f"agent not in cmd_line: {process.cmd_line}"

    await process.prompt("Use the clock agent to get the current time.")

    async for entry in process.stream_transcript(timeout=28):
        t = entry.get("type", "?")
        detail = _fmt_entry(entry)
        print(f"  [{t}] {detail}" if detail else f"  [{t}]")

    assert is_ready_for_input(process) is True

    assert process.workdir, "process.workdir should be set after prompt()"
    workdir = Path(process.workdir)
    clock_file = workdir / "clock.txt"
    assert clock_file.exists(), f"clock.txt not written by clock agent in {workdir}"
    content = clock_file.read_text().strip()
    import re
    assert re.search(r"\d{4}-\d{2}-\d{2}", content), f"No timestamp in clock.txt: {content!r}"


@pytest.mark.asyncio
# NOTE: do NOT increase timeout or mark as flaky — these tests must pass within the global 30s limit
async def test_codex_process_classify_with_agent(local_project, local_compute_node):
    agent = Agent.load_system_agent("classify")
    process = await AgenticProcess(workerType=WorkerType.CODEX).save()
    process.load_embedded_agent(agent)
    await process.prompt(
        "Use the 'classify' sub-agent to classify the following session.\n"
        "Description: 'The user asked Codex to write a Python script that prints Hello World.'\n"
        "Do NOT write classification.json yourself — let the classify sub-agent write it.",
    )

    async for entry in process.stream_transcript(timeout=28):
        t = entry.get("type", "?")
        detail = _fmt_entry(entry)
        print(f"  [{t}] {detail}" if detail else f"  [{t}]")

    assert is_ready_for_input(process) is True

    assert process.workdir, "process.workdir should be set after prompt()"
    workdir = Path(process.workdir)
    json_files = list(workdir.rglob("classification.json"))
    assert len(json_files) >= 1, f"classification.json not written by classify sub-agent in {workdir}"

    data = json.loads(json_files[0].read_text())
    assert "category" in data, f"'category' missing from: {data}"
    assert data["category"] in ("code", "debug", "explain", "design", "other")
    if "confidence" in data:
        assert isinstance(data["confidence"], (int, float))
        assert 0.0 <= data["confidence"] <= 1.0


@pytest.mark.asyncio
# NOTE: do NOT increase timeout or mark as flaky — these tests must pass within the global 30s limit
async def test_codex_process_analyze_with_agent(local_project, local_compute_node):
    """analyze system agent writes analysis.json."""
    agent = Agent.load_system_agent("analyze")
    process = await AgenticProcess(workerType=WorkerType.CODEX).save()
    process.load_embedded_agent(agent)
    await process.prompt(
        "Use the 'analyze' sub-agent to analyze the following session.\n\n"
        f"{SAMPLE_SESSION}",
    )

    async for entry in process.stream_transcript(timeout=28):
        t = entry.get("type", "?")
        detail = _fmt_entry(entry)
        print(f"  [{t}] {detail}" if detail else f"  [{t}]")

    assert is_ready_for_input(process) is True

    assert process.workdir, "process.workdir should be set after prompt()"
    workdir = Path(process.workdir)
    json_out = list(workdir.rglob("analysis.json"))
    assert len(json_out) >= 1, "analysis.json not found"

    data = json.loads(json_out[0].read_text())
    assert "session_id" in data
    assert "issues" in data
    assert isinstance(data["issues"], list)
    for issue in data["issues"]:
        assert "name" in issue
        assert "title" in issue
        assert "category" in issue
        assert issue["category"] in (
            "misunderstanding", "mistake", "inefficiency", "automation_opportunity"
        )


@pytest.mark.asyncio
# NOTE: do NOT increase timeout or mark as flaky — these tests must pass within the global 30s limit
async def test_codex_process_fix_it_with_agent(local_project, local_compute_node):
    """fix-it system agent writes analysis.json and a skill folder with SKILL.MD."""
    agent = Agent.load_system_agent("fix-it")
    process = await AgenticProcess(workerType=WorkerType.CODEX).save()
    process.load_embedded_agent(agent)
    await process.prompt(
        "Use the 'fix-it' sub-agent to analyze the following session and create a skill.\n\n"
        f"{SAMPLE_SESSION}",
    )

    async for entry in process.stream_transcript(timeout=28):
        t = entry.get("type", "?")
        detail = _fmt_entry(entry)
        print(f"  [{t}] {detail}" if detail else f"  [{t}]")

    assert is_ready_for_input(process) is True

    assert process.workdir, "process.workdir should be set after prompt()"
    workdir = Path(process.workdir)
    json_out = list(workdir.rglob("analysis.json"))
    skill_files = list(workdir.rglob("SKILL.MD"))
    assert len(json_out) >= 1, "analysis.json not found"
    assert len(skill_files) >= 1, "SKILL.MD not found in skill folder"

    data = json.loads(json_out[0].read_text())
    assert "session_id" in data
    assert "issues" in data
    assert isinstance(data["issues"], list)
    assert len(data["issues"]) >= 1

    assert len(skill_files[0].read_text()) > 50, "SKILL.MD appears empty"


@pytest.mark.asyncio
@pytest.mark.timeout(240)
@pytest.mark.flaky(reruns=2, reruns_delay=5)
async def test_codex_process_lists_system_skills(local_project, local_compute_node):
    """Verify that system skills directory contents are visible to codex."""
    import flow_sdk
    from pathlib import Path as _Path
    system_skills_path = _Path(flow_sdk.__file__).parent / "system_assets" / "available" / "skills"

    process = await AgenticProcess(workerType=WorkerType.CODEX).save()
    await process.prompt(
        f"List all subdirectory names inside {system_skills_path}. "
        "Output the names as a JSON array to skills.json — one entry per subdirectory name."
    )

    async for entry in process.stream_transcript(timeout=180):
        t = entry.get("type", "?")
        detail = _fmt_entry(entry)
        print(f"  [{t}] {detail}" if detail else f"  [{t}]")

    assert is_ready_for_input(process) is True

    assert process.workdir, "process.workdir should be set after prompt()"
    workdir = Path(process.workdir)
    skills_file = workdir / "skills.json"
    assert skills_file.exists(), "Expected skills.json to be created"

    skills = json.loads(skills_file.read_text())
    assert isinstance(skills, list), f"Expected JSON array, got: {type(skills)}"
    names = [s.lower() if isinstance(s, str) else str(s).lower() for s in skills]
    for expected in ["flow", "session_analysis"]:
        assert any(expected in n for n in names), (
            f"System skill '{expected}' not found in: {names}"
        )


@pytest.mark.asyncio
@pytest.mark.timeout(240)
@pytest.mark.flaky(reruns=2, reruns_delay=5)
async def test_codex_process_local_assets_skill(tmp_path, local_project, local_compute_node):
    """A skill placed under tmp_path/.codex/skills/ is discoverable by codex via --add-dir."""
    skill_name = "local-canary-skill"
    skill_dir = tmp_path / ".codex" / "skills" / skill_name
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        f"---\nname: {skill_name}\n"
        "description: Canary skill used only to verify --add-dir linking works\n"
        "---\n"
        "When invoked, write the word 'canary-present' to canary.txt.\n"
    )

    process = await AgenticProcess(
        workerType=WorkerType.CODEX,
        additional_dirs=[str(tmp_path)],
    ).save()
    skills_path = tmp_path / ".codex" / "skills"
    await process.prompt(
        f"List all subdirectory names inside {skills_path}. "
        "Output the names as a JSON array to skills.json — one entry per subdirectory name."
    )

    async for entry in process.stream_transcript(timeout=180):
        t = entry.get("type", "?")
        detail = _fmt_entry(entry)
        print(f"  [{t}] {detail}" if detail else f"  [{t}]")

    assert is_ready_for_input(process) is True

    assert process.workdir, "process.workdir should be set after prompt()"
    workdir = Path(process.workdir)
    skills_file = workdir / "skills.json"
    assert skills_file.exists(), "Expected skills.json to be created"

    skills = json.loads(skills_file.read_text())
    assert isinstance(skills, list), f"Expected JSON array, got: {type(skills)}"
    names = [s.lower() if isinstance(s, str) else str(s).lower() for s in skills]
    assert any(skill_name in n for n in names), (
        f"'{skill_name}' not found in skill list: {names}"
    )
