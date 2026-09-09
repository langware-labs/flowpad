"""``Agent.auto_launch_for`` — the once-per-project selection.

The session itself is stubbed (``Agent.use`` → a fake process with a fake
queue): what is under test is WHICH agent, WHEN, and what lands in the queue
and the project marker — not the worker spawn.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from flow_sdk.builtin.agent import Agent
from tests.unit.agent._seed import seed_agent as _agent, seed_project as _project


class _FakeQueue:
    def __init__(self):
        self.entries: list[tuple[str, str]] = []

    def enqueue(self, prompt: str, source: str = "ui"):
        self.entries.append((prompt, source))


class _FakeProcess:
    def __init__(self, agent: Agent, project_id: str | None):
        self.id = f"proc-{agent.name}"
        self.typeid = f"agentic_process-{self.id}"
        self.agent = agent
        self.project_id = project_id
        self.queue = _FakeQueue()


@pytest.fixture
def used(monkeypatch):
    """Stub ``Agent.use`` and capture every session it would have opened."""
    opened: list[_FakeProcess] = []

    async def _use(self, project_id=None, *, deployment=None):
        proc = _FakeProcess(self, project_id)
        opened.append(proc)
        return proc

    monkeypatch.setattr(Agent, "use", _use)
    return opened


async def test_single_candidate_launches_and_queues_its_prompt(tmp_path, used):
    root = tmp_path / "p1"
    project = await _project(root)
    agent = await _agent(root, "greeter", auto_launch=True, auto_launch_prompt="  Say hello  ")

    outcome = await Agent.auto_launch_for(project.id)

    assert outcome is not None
    payload = outcome.to_payload()
    assert payload["agent_id"] == agent.id and payload["process_id"] == used[0].id
    assert payload["cancelled"] == [] and payload["prompt_queued"] is True
    assert used[0].project_id == project.id
    assert used[0].queue.entries == [("Say hello", "auto_launch")]
    assert Agent.auto_launched_ids(project.id) == [agent.id]


async def test_second_open_never_launches_again(tmp_path, used):
    root = tmp_path / "p2"
    project = await _project(root)
    await _agent(root, "greeter", auto_launch=True, auto_launch_prompt="go")

    assert await Agent.auto_launch_for(project.id) is not None
    assert await Agent.auto_launch_for(project.id) is None
    assert len(used) == 1


async def test_oldest_wins_and_the_rest_are_cancelled_for_good(tmp_path, used):
    root = tmp_path / "p3"
    project = await _project(root)
    now = datetime.now(timezone.utc)
    # Saved NEWEST first so row order alone would pick the wrong one.
    newer = await _agent(root, "b-newer", when=now, auto_launch=True, auto_launch_prompt="b")
    oldest = await _agent(root, "c-oldest", when=now - timedelta(days=2), auto_launch=True, auto_launch_prompt="c")
    middle = await _agent(root, "a-middle", when=now - timedelta(days=1), auto_launch=True, auto_launch_prompt="a")

    outcome = await Agent.auto_launch_for(project.id)

    assert outcome is not None and outcome.agent.id == oldest.id
    assert [a.id for a in outcome.cancelled] == [middle.id, newer.id]
    assert used[0].queue.entries == [("c", "auto_launch")]
    assert set(Agent.auto_launched_ids(project.id)) == {oldest.id, middle.id, newer.id}
    # Cancelled means cancelled: the next open does not fall through to them.
    assert await Agent.auto_launch_for(project.id) is None
    assert len(used) == 1


async def test_same_age_ties_break_on_folder_name(tmp_path, used):
    root = tmp_path / "p4"
    project = await _project(root)
    when = datetime.now(timezone.utc)
    zeta = await _agent(root, "zeta", when=when, auto_launch=True)
    alpha = await _agent(root, "alpha", when=when, auto_launch=True)

    outcome = await Agent.auto_launch_for(project.id)

    assert outcome is not None and outcome.agent.id == alpha.id
    assert [a.id for a in outcome.cancelled] == [zeta.id]


async def test_disabled_off_and_foreign_agents_are_not_candidates(tmp_path, used):
    root = tmp_path / "p5"
    other = tmp_path / "p5-other"
    project = await _project(root)
    await _project(other)
    await _agent(root, "off", auto_launch=False)
    await _agent(root, "disabled", auto_launch=True, enabled=False)
    await _agent(other, "foreign", auto_launch=True)

    assert await Agent.auto_launch_for(project.id) is None
    assert used == []
    assert Agent.auto_launched_ids(project.id) == []


async def test_context_root_agents_are_in_scope(tmp_path, used):
    root = tmp_path / "p6"
    content = tmp_path / "p6-content"
    content.mkdir()
    project = await _project(root, legacy_include_dirs_=[str(content)])
    vendor = await _agent(content, "vendor-onboarding", auto_launch=True, auto_launch_prompt="hi")

    outcome = await Agent.auto_launch_for(project.id)

    assert outcome is not None and outcome.agent.id == vendor.id


async def test_empty_prompt_opens_the_session_without_a_first_turn(tmp_path, used):
    root = tmp_path / "p7"
    project = await _project(root)
    await _agent(root, "quiet", auto_launch=True, auto_launch_prompt="   ")

    outcome = await Agent.auto_launch_for(project.id)

    assert outcome is not None and outcome.prompt_queued is False
    assert used[0].queue.entries == []


async def test_unknown_project_is_a_no_op(used):
    assert await Agent.auto_launch_for("00000000-0000-4000-8000-00000000dead") is None
    assert used == []
