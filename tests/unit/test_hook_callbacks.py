"""``AgentHookCallback`` registry — ordering, isolation, and the answer rules.

Callbacks are the one hook mechanism that is deliberately NOT persisted, so the
contract lives entirely here: who runs, in what order, what happens when one
raises, and which answer wins when two callbacks both have an opinion.
"""

from __future__ import annotations

import pytest

from flow_sdk.builtin.hooks import callbacks as reg
from flow_sdk.builtin.hooks.types import ContextResponse, HookEventType
from flow_sdk.core.flow.models.webhook_flow_data import AgentHookData

TARGET = "00000000-0000-4000-8000-0000000000aa"


def _data(event: HookEventType = HookEventType.USER_PROMPT_SUBMIT) -> AgentHookData:
    return AgentHookData(agentic_process_id=TARGET, hook_data={"hook_event_name": event.value})


@pytest.fixture(autouse=True)
def _clean():
    reg.clear()
    yield
    reg.clear()


@pytest.mark.asyncio
async def test_no_callback_means_no_opinion():
    """The default answer is None — a hook nobody subscribed to never blocks."""
    assert await reg.dispatch(TARGET, _data()) is None


@pytest.mark.asyncio
async def test_callbacks_run_in_registration_order():
    seen: list[str] = []
    reg.register(TARGET, lambda d: seen.append("first"))
    reg.register(TARGET, lambda d: seen.append("second"))

    await reg.dispatch(TARGET, _data())

    assert seen == ["first", "second"]


@pytest.mark.asyncio
async def test_a_raising_callback_does_not_stop_the_others():
    seen: list[str] = []

    def boom(_data):
        raise RuntimeError("callback exploded")

    reg.register(TARGET, boom)
    reg.register(TARGET, lambda d: seen.append("still ran"))

    await reg.dispatch(TARGET, _data())

    assert seen == ["still ran"]


@pytest.mark.asyncio
async def test_first_non_none_answer_wins_and_the_second_is_dropped():
    reg.register(TARGET, lambda d: None)  # an observer abstains
    reg.register(TARGET, lambda d: ContextResponse(additional_context="first"))
    reg.register(TARGET, lambda d: ContextResponse(additional_context="second"))

    answer = await reg.dispatch(TARGET, _data())

    assert isinstance(answer, ContextResponse)
    assert answer.additional_context == "first"


@pytest.mark.asyncio
async def test_async_callbacks_are_awaited():
    async def answer(_data):
        return ContextResponse(additional_context="from async")

    reg.register(TARGET, answer)

    result = await reg.dispatch(TARGET, _data())
    assert result.additional_context == "from async"


@pytest.mark.asyncio
async def test_event_specific_callbacks_run_before_catch_alls_and_only_for_their_event():
    seen: list[str] = []
    reg.register(TARGET, lambda d: seen.append("catch-all"))
    reg.register(TARGET, lambda d: seen.append("prompt-only"), event=HookEventType.USER_PROMPT_SUBMIT)

    await reg.dispatch(TARGET, _data(), event=HookEventType.USER_PROMPT_SUBMIT)
    assert seen == ["prompt-only", "catch-all"]

    seen.clear()
    await reg.dispatch(TARGET, _data(HookEventType.SESSION_END), event=HookEventType.SESSION_END)
    assert seen == ["catch-all"]


@pytest.mark.asyncio
async def test_unsubscribe_removes_exactly_one_registration_and_is_idempotent():
    seen: list[str] = []
    drop = reg.register(TARGET, lambda d: seen.append("a"))
    reg.register(TARGET, lambda d: seen.append("b"))

    drop()
    drop()  # calling twice must not raise or remove the sibling

    await reg.dispatch(TARGET, _data())
    assert seen == ["b"]


@pytest.mark.asyncio
async def test_targets_are_isolated_from_each_other():
    other = "00000000-0000-4000-8000-0000000000bb"
    seen: list[str] = []
    reg.register(TARGET, lambda d: seen.append("mine"))
    reg.register(other, lambda d: seen.append("theirs"))

    await reg.dispatch(TARGET, _data())
    assert seen == ["mine"]


def test_a_non_callable_is_rejected_at_registration():
    with pytest.raises(TypeError):
        reg.register(TARGET, "not callable")  # type: ignore[arg-type]
