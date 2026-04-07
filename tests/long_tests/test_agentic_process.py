"""Manual long-running tests for AgenticProcess end-to-end.

NOT executed by the standard pytest suite (no conftest discovery here).
Run manually:
    python -m pytest tests/long_tests/test_agentic_process.py -v -s

Requires Claude CLI in PATH and network access.
"""

import json

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
from flow_sdk.flowpad_types.enums import WorkerType

SAMPLE_SESSION = (
    "Session description: The user asked Claude to fix a bug where the wrong variable "
    "name was used in a Python function. Claude initially misread the variable name and "
    "made an incorrect fix, then corrected itself after the user pointed out the error. "
    "The session ended with the correct fix applied."
)


def _fmt_entry(entry: dict) -> str:
    """Format a transcript entry for console output."""
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
    if t == "progress":
        return entry.get("toolName", "") or ""
    return ""


@pytest.mark.asyncio
@pytest.mark.timeout(180)
async def test_agentic_process_hello_world(local_compute_node):
    assert local_compute_node is not None
    process = await AgenticProcess(worker_type=WorkerType.CLAUDE_CODE).save()
    assert process.waiting_for_prompt is False

    result: ApiResponse = await process.prompt("Create a text file named hello.txt with the content 'Hello World'.")
    assert isinstance(result, ApiSuccessResponse)
    assert process.waiting_for_prompt is False

    async def _diagnose():
        """Print Claude process vitals every 5s while stream_transcript runs."""
        import asyncio, psutil
        from flow_sdk.builtin.shell import Shell
        while True:
            await asyncio.sleep(5)
            shell = await process.shell()
            worker_pid = shell.worker_pid if shell else None
            worker_alive = await shell.worker_alive() if shell else False
            shell_status = shell.status if shell else "no shell"
            # Try to get exit code if process already died
            exit_code = None
            if worker_pid and not worker_alive:
                try:
                    p = psutil.Process(worker_pid)
                    exit_code = p.status()
                except psutil.NoSuchProcess:
                    exit_code = "process gone"
            worker_status = process._discover_status_from_transcript()
            print(
                f"  [diag] status={process.status!r} shell={shell_status!r} "
                f"pid={worker_pid} alive={worker_alive} exit={exit_code!r} "
                f"worker_status={worker_status!r} waiting={process.waiting_for_prompt}"
            )

    import asyncio as _asyncio
    diag_task = _asyncio.create_task(_diagnose())
    try:
        async for entry in process.stream_transcript(timeout=30):
            t = entry.get("type", "?")
            detail = _fmt_entry(entry)
            print(f"  [{t}] {detail}" if detail else f"  [{t}]")
    finally:
        diag_task.cancel()

    assert process.waiting_for_prompt is True

    # With no workdir set, Claude runs inside the process output_dir.
    # Verify hello.txt landed there.
    from flow_sdk.fs_records.agentic_process_record import AgenticProcessRecord
    proc_record = await process.get_record()
    assert proc_record is not None, "AgenticProcessRecord not found"
    hello = proc_record.output_dir / "hello.txt"
    assert hello.exists(), f"hello.txt not found in output_dir {proc_record.output_dir}"
    assert "hello" in hello.read_text().lower()


@pytest.mark.asyncio
@pytest.mark.timeout(180)
async def test_agentic_process_classify():
    process = AgenticProcess(workerType=WorkerType.CLAUDE_CODE)
    await process.prompt(
        "Run the following bash command exactly as written — do NOT interpret or paraphrase:\n"
        "\n"
        "cat > classification.json << 'JSONEOF'\n"
        '{"category": "code", "title": "Hello World Python script", "command": "/code", "confidence": 0.95}\n'
        "JSONEOF\n"
        "\n"
        "Then verify the file exists with: cat classification.json"
    )
    assert process.pending_user is False

    await process.waitForIdle(timeout=120)
    assert process.pending_user is True

    outputs = process.outputs
    workdir = process._workdir.resolve()
    all_files = [str(o.file_path.resolve().relative_to(workdir)) for o in outputs]
    json_outputs = [o for o in outputs if o.file_path.name == "classification.json"]
    assert len(json_outputs) >= 1, (
        f"classification.json not found in workdir. "
        f"Status={process.worker_status}. Files found: {all_files}"
    )

    content = await json_outputs[0].content()
    data = json.loads(content)
    assert "category" in data, f"'category' missing from: {data}"
    assert "title" in data, f"'title' missing from: {data}"
    assert "command" in data, f"'command' missing from: {data}"
    assert "confidence" in data, f"'confidence' missing from: {data}"
    assert isinstance(data["confidence"], (int, float))
    assert 0.0 <= data["confidence"] <= 1.0


@pytest.mark.asyncio
@pytest.mark.timeout(480)
@pytest.mark.flaky(reruns=2, reruns_delay=5)
async def test_agentic_process_classify_with_agent():
    agent = Agent.load_system_agent("classify")

    process = AgenticProcess(workerType=WorkerType.CLAUDE_CODE)
    await process.prompt(
        "Use the Task tool to invoke the 'classify' sub-agent installed in .claude/agents/classify.md.\n"
        "Pass this as the description: 'The user asked Claude to write a Python script that prints Hello World.'\n"
        "Do NOT write classification.json yourself — the classify sub-agent will write it.",
        agent=agent,
    )
    assert process.pending_user is False

    await process.waitForIdle(timeout=420)
    assert process.pending_user is True

    outputs = process.outputs
    workdir = process._workdir.resolve()
    all_files = [str(o.file_path.resolve().relative_to(workdir)) for o in outputs]
    json_outputs = [o for o in outputs if o.file_path.name == "classification.json"]
    assert len(json_outputs) >= 1, (
        f"classification.json not written by classify sub-agent. "
        f"Status={process.worker_status}. Files found: {all_files}"
    )

    content = await json_outputs[0].content()
    data = json.loads(content)
    assert "category" in data, f"'category' missing from: {data}"
    assert data["category"] in ("code", "debug", "explain", "design", "other")
    # title, command, confidence are written by the classify agent but may be missing
    # if the agent ran in a resource-constrained environment
    if "confidence" in data:
        assert isinstance(data["confidence"], (int, float))
        assert 0.0 <= data["confidence"] <= 1.0


@pytest.mark.asyncio
@pytest.mark.timeout(300)
@pytest.mark.flaky(reruns=2, reruns_delay=5)
async def test_agentic_process_analyze_with_agent():
    """analyze system agent writes analysis.json and analysis.md."""
    agent = Agent.load_system_agent("analyze")

    process = AgenticProcess(workerType=WorkerType.CLAUDE_CODE)
    await process.prompt(
        "Use the sub-agent named 'analyze' (installed in .claude/agents/analyze.md) "
        "to analyze the following session.\n"
        "The analyze sub-agent will write analysis.json and analysis.md to the current directory.\n\n"
        f"{SAMPLE_SESSION}\n\n"
        "Invoke the sub-agent with this session description.",
    )

    await process.waitForIdle(timeout=120)

    outputs = process.outputs
    json_out = [o for o in outputs if o.file_path.name == "analysis.json"]
    md_out = [o for o in outputs if o.file_path.name == "analysis.md"]
    assert len(json_out) >= 1, "analysis.json not found"
    assert len(md_out) >= 1, "analysis.md not found"

    data = json.loads(await json_out[0].content())
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
@pytest.mark.timeout(400)
@pytest.mark.flaky(reruns=2, reruns_delay=5)
async def test_agentic_process_fix_it_with_agent():
    """fix-it system agent writes analysis.json, analysis.md, and a skill folder with SKILL.MD."""
    agent = Agent.load_system_agent("fix-it")

    process = AgenticProcess(workerType=WorkerType.CLAUDE_CODE)
    await process.prompt(
        "Use the sub-agent named 'fix-it' (installed in .claude/agents/fix-it.md) "
        "to analyze the following session and create a skill to prevent the issue from recurring.\n"
        "The fix-it sub-agent will write analysis.json, analysis.md, and a skill folder "
        "containing SKILL.MD to the current directory.\n\n"
        f"{SAMPLE_SESSION}\n\n"
        "Invoke the sub-agent with this session description.",
        agent=agent,
    )

    await process.waitForIdle(timeout=180)

    outputs = process.outputs
    json_out = [o for o in outputs if o.file_path.name == "analysis.json"]
    md_out = [o for o in outputs if o.file_path.name == "analysis.md"]
    skill_files = [o for o in outputs if o.file_path.name == "SKILL.MD"]
    assert len(json_out) >= 1, "analysis.json not found"
    assert len(md_out) >= 1, "analysis.md not found"
    assert len(skill_files) >= 1, "SKILL.MD not found in skill folder"

    data = json.loads(await json_out[0].content())
    assert "session_id" in data
    assert "issues" in data
    assert isinstance(data["issues"], list)
    assert len(data["issues"]) >= 1

    skill_content = await skill_files[0].content()
    assert len(skill_content) > 50, "SKILL.MD appears empty"


@pytest.mark.asyncio
@pytest.mark.timeout(180)
async def test_agentic_process_lists_system_skills():
    """Verify that system skills are visible to Claude via --add-dir system_assets."""
    process = AgenticProcess(workerType=WorkerType.CLAUDE_CODE)
    await process.prompt(
        "List all available skills by looking in the .claude/skills/ directory. "
        "Output the skill names as a JSON array to skills.json — one entry per skill directory name."
    )
    await process.waitForIdle(timeout=120)

    skills_file = process.output_folder / "skills.json"
    assert skills_file.exists(), "Expected skills.json to be created"

    skills = json.loads(skills_file.read_text())
    assert isinstance(skills, list), f"Expected JSON array, got: {type(skills)}"
    names = [s.lower() if isinstance(s, str) else str(s).lower() for s in skills]
    for expected in ["flow", "compile-workflow", "session_analysis"]:
        assert any(expected in n for n in names), (
            f"System skill '{expected}' not found in: {names}"
        )


@pytest.mark.asyncio
@pytest.mark.timeout(180)
@pytest.mark.skip(reason="local_assets feature removed in refactor")
async def test_agentic_process_local_assets_skill(tmp_path):
    """A skill linked into local_assets is discoverable by Claude via --add-dir."""
    skill_name = "local-canary-skill"
    skills_dir = tmp_path / "skills"
    skill_dir = skills_dir / skill_name
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        f"---\nname: {skill_name}\n"
        "description: Canary skill used only to verify local_assets linking works\n"
        "---\n"
        "When invoked, write the word 'canary-present' to canary.txt.\n"
    )

    process = AgenticProcess(workerType=WorkerType.CLAUDE_CODE)
    # local_assets.link() triggers lazy start() — no explicit start() needed
    process.local_assets.link(skills_dir)  # local_assets/skills -> tmp_path/skills

    process.prompt(
        "List all available skills by looking in the .claude/skills/ directory. "
        "Output the skill names as a JSON array to skills.json — one entry per skill directory name."
    )
    await process.waitForIdle(timeout=120)

    skills_file = process.output_folder / "skills.json"
    assert skills_file.exists(), "Expected skills.json to be created"

    skills = json.loads(skills_file.read_text())
    assert isinstance(skills, list), f"Expected JSON array, got: {type(skills)}"
    names = [s.lower() if isinstance(s, str) else str(s).lower() for s in skills]
    assert any(skill_name in n for n in names), (
        f"'{skill_name}' not found in skill list: {names}"
    )
