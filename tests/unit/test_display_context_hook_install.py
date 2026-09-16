"""A Vibe session answers ``UserPromptSubmit`` with its display context.

Loading the SDK's ``vibe`` persona — the one that gives a session its display
pane — installs the prompt hook before launch, so the page's display context
reaches the agent each turn (``display_context.py``). Nothing else does: another
persona, the vibe sub-agent merely layered in, or a worker whose harness never
reads the hook's answer.
"""

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.hooks.types import HookEventType
from flow_sdk.flowpad_types.enums import WorkerType

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

PROMPT = HookEventType.USER_PROMPT_SUBMIT.value


@pytest.fixture(autouse=True)
def _records(tmp_records_root):
    """Records stay under the test's temp dir."""


def persona(root, name):
    path = root / name / ".claude" / "agents" / f"{name}.md"
    path.parent.mkdir(parents=True)
    path.write_text(f"---\nid: {mint_uuid()}\nname: {name}\n---\n\nYou are {name}.\n")
    return str(path)


async def _load(tmp_path, worker_type, name, *, as_persona):
    process = AgenticProcess(worker_type=worker_type, workdir=str(tmp_path))
    result = await process.load_embedded_subagent_action(persona(tmp_path, name), set_ap_persona=as_persona)
    assert result.status == "SUCCESS", result
    return process


async def test_the_vibe_persona_installs_the_prompt_hook(tmp_path):
    process = await _load(tmp_path, WorkerType.CLAUDE_CODE, "vibe", as_persona=True)
    assert PROMPT in (process.process_hook_events or [])


async def test_another_persona_does_not(tmp_path):
    process = await _load(tmp_path, WorkerType.CLAUDE_CODE, "standard", as_persona=True)
    assert PROMPT not in (process.process_hook_events or [])


async def test_vibe_layered_without_the_persona_role_does_not(tmp_path):
    process = await _load(tmp_path, WorkerType.CLAUDE_CODE, "vibe", as_persona=False)
    assert PROMPT not in (process.process_hook_events or [])


async def test_a_harness_that_ignores_hook_answers_does_not(tmp_path):
    process = await _load(tmp_path, WorkerType.CODEX, "vibe", as_persona=True)
    assert PROMPT not in (process.process_hook_events or [])
