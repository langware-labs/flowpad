"""displayContext — a shown page's live state reaches the agent beside it.

Drives the documented action surface through the in-process app: the page's
write (``set-display-context``), the agent's on-demand read (``display-context``,
what ``flow context display`` calls), the binding to what is on display
(``show`` of another target makes it stale), and the per-turn delivery through a
``UserPromptSubmit`` hook webhook — no worker, no LLM.
"""

from __future__ import annotations

import pytest

from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.display_context import MAX_DATA_BYTES
from flow_sdk.builtin.hooks import HookEventType
from flow_sdk.builtin.hooks.types import HOOK_OUTCOME_KEY, ContextResponse, HookOutcome
from flow_sdk.responses.response import ApiResponse
from tests.api.conftest import create_agentic_process, get_agentic_process

# do not increase timeout without approval
pytestmark = [pytest.mark.timeout(30), pytest.mark.usefixtures("reset_db_for_testclient")]

PROMPT = HookEventType.USER_PROMPT_SUBMIT


@pytest.fixture
async def pid(bootstrapped_client, user) -> str:
    """A never-launched process."""
    return await create_agentic_process(bootstrapped_client, visible=False, pty_mode=False)


def _page(tmp_path, name: str) -> str:
    path = tmp_path / name
    path.write_text("<html><head></head><body>page</body></html>", encoding="utf-8")
    return str(path)


async def _show(client, pid: str, path: str) -> None:
    resp = await client.post(f"/api/v1/graph/agentic_process/{pid}/show", json={"path": path})
    assert resp.status_code == 200, resp.text


async def _set(client, pid: str, data):
    return await client.post(f"/api/v1/graph/agentic_process/{pid}/set-display-context", json={"data": data})


async def _read(client, pid: str) -> dict:
    resp = await client.get(f"/api/v1/graph/agentic_process/{pid}/display-context")
    assert resp.status_code == 200, resp.text
    return ApiResponse(**resp.json()).data


def _prompt_hook(pid: str) -> dict:
    return {
        "webhook_type": "agent_hook",
        "webhook_payload": {
            "agentic_process_id": pid,
            "hook_data": {"raw_hook_data": {"hook_event_name": PROMPT.value, "prompt": "hi"}},
        },
    }


async def _injected(client, pid: str) -> str | None:
    resp = await client.post("/api/v1/webhook/listen", json=_prompt_hook(pid))
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    if HOOK_OUTCOME_KEY not in data:
        return None
    outcome = HookOutcome.from_wire(data[HOOK_OUTCOME_KEY])
    return (outcome.stdout or {}).get("hookSpecificOutput", {}).get("additionalContext")


@pytest.mark.asyncio
async def test_nothing_shown_refuses_a_context(bootstrapped_client, pid):
    resp = await _set(bootstrapped_client, pid, {"lesson": 1})

    assert resp.status_code == 409, resp.text
    assert (await _read(bootstrapped_client, pid))["fresh"] is False


@pytest.mark.asyncio
async def test_a_context_is_bound_to_the_shown_page_and_versioned(bootstrapped_client, pid, tmp_path):
    page = _page(tmp_path, "lesson.html")
    await _show(bootstrapped_client, pid, page)

    first = await _set(bootstrapped_client, pid, {"lesson": 1, "results": [True, False]})
    assert first.status_code == 200, first.text
    state = await _read(bootstrapped_client, pid)
    assert state["fresh"] is True
    assert state["target"]["path"] == page
    assert state["version"] == 1
    assert state["data"] == {"lesson": 1, "results": [True, False]}

    # Wholesale replace, not a merge: the shorter array and dropped key are gone.
    await _set(bootstrapped_client, pid, {"lesson": 2, "results": [True]})
    state = await _read(bootstrapped_client, pid)
    assert state["version"] == 2
    assert state["data"] == {"lesson": 2, "results": [True]}


@pytest.mark.asyncio
async def test_reporting_the_same_state_again_writes_nothing(bootstrapped_client, pid, tmp_path):
    """A page that re-sends unchanged state must not bump the version the agent is handed."""
    await _show(bootstrapped_client, pid, _page(tmp_path, "lesson.html"))
    await _set(bootstrapped_client, pid, {"lesson": 1})

    again = await _set(bootstrapped_client, pid, {"lesson": 1})

    assert again.status_code == 200, again.text
    assert (await _read(bootstrapped_client, pid))["version"] == 1


@pytest.mark.asyncio
async def test_showing_another_page_drops_the_context(bootstrapped_client, pid, tmp_path):
    await _show(bootstrapped_client, pid, _page(tmp_path, "a.html"))
    await _set(bootstrapped_client, pid, {"lesson": 1})

    await _show(bootstrapped_client, pid, _page(tmp_path, "b.html"))

    assert (await _read(bootstrapped_client, pid))["fresh"] is False
    row = await get_agentic_process(bootstrapped_client, pid)
    assert "display_context" not in row["context_data"]


@pytest.mark.asyncio
async def test_oversized_data_is_refused(bootstrapped_client, pid, tmp_path):
    await _show(bootstrapped_client, pid, _page(tmp_path, "big.html"))

    resp = await _set(bootstrapped_client, pid, {"blob": "x" * (MAX_DATA_BYTES + 1)})

    assert resp.status_code == 413, resp.text


@pytest.mark.asyncio
async def test_a_stale_process_save_does_not_clobber_the_context(bootstrapped_client, pid, tmp_path):
    await _show(bootstrapped_client, pid, _page(tmp_path, "page.html"))
    stale = await AgenticProcess.get_by_id(pid)
    assert stale is not None

    await _set(bootstrapped_client, pid, {"lesson": 7})
    stale.status_report = {"kind": "process_status", "status": "ready"}
    await stale.save()

    state = await _read(bootstrapped_client, pid)
    assert state["fresh"] is True
    assert state["data"] == {"lesson": 7}


@pytest.mark.asyncio
async def test_the_prompt_hook_hands_each_new_version_to_the_agent_once(bootstrapped_client, pid, tmp_path):
    process = await AgenticProcess.get_by_id(pid)
    await process.hooks.configure(PROMPT)
    page = _page(tmp_path, "lesson.html")
    await _show(bootstrapped_client, pid, page)

    # Nothing written yet → the turn is not touched.
    assert await _injected(bootstrapped_client, pid) is None

    await _set(bootstrapped_client, pid, {"lesson": 3, "code": "<ul><li>a</li></ul>"})
    text = await _injected(bootstrapped_client, pid)
    assert text is not None
    assert "<display-context" in text and 'version="1"' in text
    assert '"lesson": 3' in text and page in text

    # Unchanged page state is not re-sent on the next turn.
    assert await _injected(bootstrapped_client, pid) is None

    await _set(bootstrapped_client, pid, {"lesson": 4})
    text = await _injected(bootstrapped_client, pid)
    assert text is not None and 'version="2"' in text and '"lesson": 4' in text


@pytest.mark.asyncio
async def test_a_registered_callback_answer_wins_over_the_display_context(bootstrapped_client, pid, tmp_path):
    process = await AgenticProcess.get_by_id(pid)
    await process.hooks.configure(PROMPT)
    await _show(bootstrapped_client, pid, _page(tmp_path, "page.html"))
    await _set(bootstrapped_client, pid, {"lesson": 1})

    unsubscribe = process.hooks.set_callback(lambda data: ContextResponse(additional_context="explicit"))
    try:
        assert await _injected(bootstrapped_client, pid) == "explicit"
    finally:
        unsubscribe()
    # Not consumed by the callback's turn: the context is still delivered next.
    assert "<display-context" in (await _injected(bootstrapped_client, pid) or "")
