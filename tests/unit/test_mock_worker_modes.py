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


class _Proc:
    """Just enough process for file actions: a record dir and a workdir."""

    def __init__(self, root):
        self._root, self.workdir, self.session_id = root, str(root / "work"), "s1"

    def _record_dir(self):
        return self._root / "record"


def _tools(turn) -> list[tuple[str, dict]]:
    calls = [e["message"]["content"][0] for e in turn.entries if e["type"] == "assistant"]
    return [(c["name"], c["input"]) for c in calls]


def test_file_actions_change_disk_and_record_the_tool_call_a_real_worker_makes(tmp_path):
    turn = MockTurn(prompt="", process=_Proc(tmp_path), vendor="claude")
    assert turn.input_dir == tmp_path / "record" / "execution" / "input"
    assert turn.output_dir == tmp_path / "record" / "execution" / "output"

    draft = turn.write(turn.output_dir / "draft.md", "# CV\nold line")
    turn.edit(draft, "old line", "new line")
    final = turn.rename(draft, turn.output_dir / "body.md")
    turn.write("scratch.txt", "tmp")                       # relative -> the process's workdir
    turn.delete("scratch.txt")

    assert final.read_text() == "# CV\nnew line" and not draft.exists()
    assert not (tmp_path / "work" / "scratch.txt").exists()
    assert turn.read(final) == "# CV\nnew line"
    assert turn.listdir(turn.output_dir) == ["body.md"]
    names = [n for n, _ in _tools(turn)]
    assert names == ["Write", "Edit", "Bash", "Write", "Bash", "Read", "Bash"]
    assert _tools(turn)[2][1]["command"].startswith("mv ") and _tools(turn)[4][1]["command"].startswith("rm ")


def test_a_test_written_handler_replaces_the_default_action(tmp_path):
    written: list[str] = []

    def wrong_name(turn, path, content):                   # the agent writes the right data under the wrong name
        (path.parent / "cv_spec.json").parent.mkdir(parents=True, exist_ok=True)
        (path.parent / "cv_spec.json").write_text(content)
        written.append(path.name)

    def refuse(turn, path):
        raise PermissionError(f"read-only: {path}")

    turn = MockTurn(prompt="", process=_Proc(tmp_path), vendor="claude", handlers={"write": wrong_name, "delete": refuse})
    turn.write(turn.output_dir / "cv.json", "{}")
    assert written == ["cv.json"] and (turn.output_dir / "cv_spec.json").exists() and not (turn.output_dir / "cv.json").exists()
    with pytest.raises(PermissionError):
        turn.delete(turn.output_dir / "cv_spec.json")
    assert _tools(turn) == [("Write", {"file_path": str(turn.output_dir / "cv.json"), "content": "{}"})], \
        "a failed action records no tool call"


def test_the_driver_hands_its_handlers_to_every_turn(tmp_path):
    from tests.utils.mock_worker import MockDriver  # noqa: PLC0415

    marker = object()
    driver = MockDriver(tmp_path, behavior=lambda t: "ok", handlers={"write": marker})
    assert driver.handlers == {"write": marker}
