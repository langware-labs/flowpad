"""MockWorker's modes: a mock on top of every real vendor driver keeps that vendor's traits, settles
at once, and refuses what a real worker in its position could not do."""
from __future__ import annotations

import pytest

from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import get_driver
from tests.utils.mock_worker import MOCK_VENDORS, MockTurn, MockUsageError, mock_driver_for

pytestmark = [pytest.mark.timeout(5)]  # do not increase timeout without approval


@pytest.mark.parametrize("vendor", MOCK_VENDORS)
def test_the_mock_is_the_vendors_own_driver_with_only_the_model_replaced(vendor, tmp_path):
    real = type(get_driver(vendor))
    mock = mock_driver_for(vendor, tmp_path, behavior=lambda turn: "ok")
    assert isinstance(mock, real) and mock.vendor_key == vendor
    assert getattr(mock, "spawns_subagents", False) == getattr(real, "spawns_subagents", False)
    assert mock.transcript_settle_seconds == 0 and mock.transcript_poll_seconds <= 0.01


def test_only_claude_spawns_native_subagents():
    assert [v for v in MOCK_VENDORS if getattr(type(get_driver(v)), "spawns_subagents", False)] == ["claude"]


def _turn(**kw) -> MockTurn:
    return MockTurn(prompt="", process=object(), vendor=kw.pop("vendor", "claude"), **kw)


def test_a_native_subagent_is_called_only_where_the_harness_spawns_and_only_from_its_roster():
    with pytest.raises(MockUsageError, match="cannot spawn"):
        _turn(vendor="codex").native_subagent("general-worker", "x", "y")
    with pytest.raises(MockUsageError, match="roster"):
        _turn(spawns_subagents=True, agents={"general-worker": {}}).native_subagent("ghost", "x", "y")
    turn = _turn(spawns_subagents=True, agents={"general-worker": {}})
    assert turn.native_subagent("general-worker", "Look it up", "17") == "17"
    call = turn.entries[0]["message"]["content"][0]
    assert call["name"] == "Agent" and call["input"]["subagent_type"] == "general-worker"
    assert turn.entries[1]["message"]["content"][0]["content"] == "17", "the tool call and its result, transcript-shaped"


@pytest.mark.asyncio
async def test_flow_needs_a_runner_and_records_the_call():
    with pytest.raises(MockUsageError, match="flow runner"):
        await _turn().flow("task", "list")

    async def runner(process, argv):
        return {"ok": True, "argv": argv}

    turn = _turn(_flow=runner)
    assert (await turn.flow("task", "list"))["argv"] == ["task", "list"]
    assert turn.flow_calls == [["task", "list"]] and turn.entries[0]["message"]["content"][0]["input"]["command"] == "flow task list"


def test_the_chief_is_recognised_by_what_its_instructions_carry():
    from flow_sdk.tasks.cos import COS_MARKER  # noqa: PLC0415

    assert _turn(instructions=f"{COS_MARKER}\n# Chief of Staff").is_chief_of_staff
    assert not _turn(instructions="You are Dana.").is_chief_of_staff
