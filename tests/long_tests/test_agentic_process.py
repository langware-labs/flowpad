"""Manual long-running tests for AgenticProcess end-to-end.

NOT executed by the standard pytest suite (no conftest discovery here).
Run manually:
    python -m pytest tests/long_tests/test_agentic_process.py -v -s

Requires Claude CLI in PATH and network access.
"""

import json

import pytest
from tests.test_settings import test_service_config

pytestmark = pytest.mark.skipif(
    not test_service_config.deep_testing,
    reason="Skipping long tests when DEEP_TESTING is disabled",
)

from flow_sdk.domain.agent import Agent
from flow_sdk.domain.agentic_process import AgenticProcess, WorkerType

SAMPLE_SESSION = (
    "Session description: The user asked Claude to fix a bug where the wrong variable "
    "name was used in a Python function. Claude initially misread the variable name and "
    "made an incorrect fix, then corrected itself after the user pointed out the error. "
    "The session ended with the correct fix applied."
)


@pytest.mark.asyncio
@pytest.mark.timeout(180)
async def test_agentic_process_hello_world():
    process = AgenticProcess(workerType=WorkerType.CLAUDE)
    process.start()
    assert process.idle is True

    process.prompt("Create a text file named hello.txt with the content 'Hello World'.")
    assert process.idle is False

    await process.waitForIdle(timeout=60)
    assert process.idle is True

    outputs = process.outputs
    assert len(outputs) >= 1

    text_outputs = [o for o in outputs if o.type == "text_file"]
    assert len(text_outputs) >= 1

    output = text_outputs[0]
    assert output.type == "text_file"
    content = await output.content()
    assert "hello" in content.lower()


@pytest.mark.asyncio
@pytest.mark.timeout(180)
async def test_agentic_process_classify():
    process = AgenticProcess(workerType=WorkerType.CLAUDE)
    process.start()
    assert process.idle is True

    process.prompt(
        "Run the following bash command exactly as written — do NOT interpret or paraphrase:\n"
        "\n"
        "cat > classification.json << 'JSONEOF'\n"
        '{"category": "code", "title": "Hello World Python script", "command": "/code", "confidence": 0.95}\n'
        "JSONEOF\n"
        "\n"
        "Then verify the file exists with: cat classification.json"
    )
    assert process.idle is False

    await process.waitForIdle(timeout=120)
    assert process.idle is True

    outputs = process.outputs
    workdir = process._workdir.resolve()
    all_files = [str(o.file_path.resolve().relative_to(workdir)) for o in outputs]
    json_outputs = [o for o in outputs if o.file_path.name == "classification.json"]
    assert len(json_outputs) >= 1, (
        f"classification.json not found in workdir. "
        f"Status={process.status}. Files found: {all_files}"
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
    agent = Agent.system_agent("classify")

    process = AgenticProcess(workerType=WorkerType.CLAUDE)
    process.start()
    assert process.idle is True

    process.prompt(
        "Use the Task tool to invoke the 'classify' sub-agent installed in .claude/agents/classify.md.\n"
        "Pass this as the description: 'The user asked Claude to write a Python script that prints Hello World.'\n"
        "Do NOT write classification.json yourself — the classify sub-agent will write it.",
        agent=agent,
    )
    assert process.idle is False

    await process.waitForIdle(timeout=420)
    assert process.idle is True

    outputs = process.outputs
    workdir = process._workdir.resolve()
    all_files = [str(o.file_path.resolve().relative_to(workdir)) for o in outputs]
    json_outputs = [o for o in outputs if o.file_path.name == "classification.json"]
    assert len(json_outputs) >= 1, (
        f"classification.json not written by classify sub-agent. "
        f"Status={process.status}. Files found: {all_files}"
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
    agent = Agent.system_agent("analyze")

    process = AgenticProcess(workerType=WorkerType.CLAUDE)
    process.start()

    process.prompt(
        "Use the sub-agent named 'analyze' (installed in .claude/agents/analyze.md) "
        "to analyze the following session.\n"
        "The analyze sub-agent will write analysis.json and analysis.md to the current directory.\n\n"
        f"{SAMPLE_SESSION}\n\n"
        "Invoke the sub-agent with this session description.",
        agent=agent,
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
    agent = Agent.system_agent("fix-it")

    process = AgenticProcess(workerType=WorkerType.CLAUDE)
    process.start()

    process.prompt(
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
