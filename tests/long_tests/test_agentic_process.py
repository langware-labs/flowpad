"""Long-running end-to-end tests for AgenticProcess.

Vendor-blind: every test runs once per registered driver (claude, codex) via
the ``make_process`` / ``external_session_snapshot`` fixtures in conftest.
Test bodies do NOT mention ``WorkerType``, ``ClaudeCli*``, ``Codex*``, or any
other worker-specific symbol — anything they need from the worker is exposed
through a driver method or fixture. Tests that addressing specific worker
properties / methods would be a design problem.

NOT executed by the standard pytest suite (no conftest discovery here).
Run manually:
    DEEP_TESTING=1 python -m pytest tests/long_tests/test_agentic_process.py -v -s

Requires either ``claude`` or ``codex`` CLI in PATH (whichever the
parameterised driver wants) and network access.
"""

import json
import re
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
from flow_sdk.builtin.agentic_process.status_predicates import is_ready_for_input

SAMPLE_SESSION = (
    "Session description: The user asked the agent to fix a bug where the wrong variable "
    "name was used in a Python function. The agent initially misread the variable name and "
    "made an incorrect fix, then corrected itself after the user pointed out the error. "
    "The session ended with the correct fix applied."
)


def _fmt_entry(entry: dict) -> str:
    """Format a transcript entry for console output (vendor-agnostic).

    Recognises both Claude's ``{type: assistant, message: {content: [...]}}``
    shape and Codex's ``{type: item.completed, item: {...}}`` shape — purely
    cosmetic, never asserted on.
    """
    t = entry.get("type", "?")
    if t == "assistant":
        msg = entry.get("message", {})
        content = msg.get("content", [])
        if isinstance(content, list):
            parts = []
            for block in content:
                if block.get("type") == "text":
                    parts.append(block["text"][:120].replace("\n", " "))
                elif block.get("type") == "tool_use":
                    parts.append(f"[tool: {block.get('name')}]")
            return " | ".join(parts) if parts else "(empty)"
        return str(content)[:120]
    if t == "user":
        msg = entry.get("message", {})
        content = msg.get("content", "")
        if isinstance(content, list):
            return " ".join(c.get("content", "") if isinstance(c.get("content"), str) else "" for c in content)[:120]
        return str(content)[:120]
    if t == "item.completed":
        item = entry.get("item") or {}
        if item.get("type") == "agent_message":
            return (item.get("text") or "")[:120].replace("\n", " ")
        if item.get("type") == "command_execution":
            return f"[shell] (exit={item.get('exit_code')})"
        if item.get("type") == "file_change":
            return f"[file_change] {len(item.get('changes') or [])} change(s)"
    if t == "turn.completed":
        return "[turn done]"
    return ""


@pytest.mark.asyncio
@pytest.mark.timeout(180)
@pytest.mark.flaky(reruns=2, reruns_delay=5)
async def test_agentic_process_hello_world(
    make_process, external_session_snapshot, local_project, local_compute_node,
):
    assert local_compute_node is not None
    sessions_before = external_session_snapshot()

    process = await make_process()
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

    # Driver-managed session storage shouldn't leak entries between turns.
    new_sessions = external_session_snapshot() - sessions_before
    assert not new_sessions, (
        f"new entries appeared in vendor session storage: {new_sessions}"
    )

    # ── get-history action: transcript should be materialized, convertible to
    #    FlowData, and reachable through the same server action the UI uses.
    assert process.session_id, "process.session_id must be set after prompt completes"

    action_resp = await process.get_history_action()
    assert isinstance(action_resp, ApiSuccessResponse), (
        f"expected ApiSuccessResponse, got {type(action_resp).__name__}"
    )
    data = action_resp.data or {}
    assert data.get("session_id") == process.session_id
    history_items = data.get("history") or []
    assert history_items, "server action returned empty history"
    first = history_items[0]
    # Shape matches what TS FlowData.fromJSON expects.
    for key in ("flow_value", "attributes", "index", "created_time"):
        assert key in first, f"missing {key!r} in history item: {first}"
    # An assistant-flavoured entry should appear (text, tool_use, or item).
    roles = {item.get("attributes", {}).get("role") for item in history_items}
    assert "assistant" in roles, f"expected an assistant entry in history, got roles={roles}"


@pytest.mark.asyncio
@pytest.mark.timeout(180)
@pytest.mark.flaky(reruns=2, reruns_delay=5)
async def test_agentic_process_classify(
    make_process, local_project, local_compute_node,
):
    process = await make_process()
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
    assert "category" in data
    assert "title" in data
    assert "command" in data
    assert "confidence" in data
    assert isinstance(data["confidence"], (int, float))
    assert 0.0 <= data["confidence"] <= 1.0


@pytest.mark.asyncio
# NOTE: do NOT increase timeout or mark as flaky — these tests must pass within the global 30s limit
async def test_agentic_process_clock_agent(
    make_process, local_project, local_compute_node,
):
    agent = Agent(
        name="the-clock-agent",
        description="Returns the current timestamp. Use when asked for the current time.",
        prompt='Run `date -u +"%Y-%m-%dT%H:%M:%SZ"` and write the result to clock.txt.',
    )
    process = await make_process()
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
    assert re.search(r"\d{4}-\d{2}-\d{2}", content), f"No timestamp in clock.txt: {content!r}"


@pytest.mark.asyncio
# NOTE: do NOT increase timeout or mark as flaky — these tests must pass within the global 30s limit
async def test_agentic_process_classify_with_agent(
    make_process, local_project, local_compute_node,
):
    agent = Agent.load_system_agent("classify")
    process = await make_process()
    process.load_embedded_agent(agent)
    await process.prompt(
        "Use the 'classify' sub-agent to classify the following session.\n"
        "Description: 'The user asked the agent to write a Python script that prints Hello World.'\n"
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
    assert "category" in data
    assert data["category"] in ("code", "debug", "explain", "design", "other")
    if "confidence" in data:
        assert isinstance(data["confidence"], (int, float))
        assert 0.0 <= data["confidence"] <= 1.0


@pytest.mark.asyncio
# NOTE: do NOT increase timeout or mark as flaky — these tests must pass within the global 30s limit
async def test_agentic_process_analyze_with_agent(
    make_process, local_project, local_compute_node,
):
    """analyze system agent writes analysis.json."""
    agent = Agent.load_system_agent("analyze")
    process = await make_process()
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
async def test_agentic_process_fix_it_with_agent(
    make_process, local_project, local_compute_node,
):
    """fix-it system agent writes analysis.json and a skill folder with SKILL.MD."""
    agent = Agent.load_system_agent("fix-it")
    process = await make_process()
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
async def test_agentic_process_lists_system_skills(
    make_process, local_project, local_compute_node,
):
    """Verify that system skills are visible to the worker via --add-dir."""
    from flow_sdk.config import flowpad_assistant_project_root
    system_skills_path = flowpad_assistant_project_root() / ".claude" / "skills"

    process = await make_process()
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
async def test_agentic_process_local_assets_skill(
    tmp_path, make_process, local_project, local_compute_node,
):
    """A skill placed under tmp_path/.claude/skills/ is discoverable via --add-dir."""
    skill_name = "local-canary-skill"
    skill_dir = tmp_path / ".claude" / "skills" / skill_name
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        f"---\nname: {skill_name}\n"
        "description: Canary skill used only to verify --add-dir linking works\n"
        "---\n"
        "When invoked, write the word 'canary-present' to canary.txt.\n"
    )

    process = await make_process(additional_dirs=[str(tmp_path)])
    skills_path = tmp_path / ".claude" / "skills"
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
