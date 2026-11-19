"""Steering a ticket's agent: one admin turn, a status back and never the agent's words, the reply mode decides the send.

``steer`` (the box route's, which only the hub's hop reaches) runs over fakes for the placement, the engine and the
channel: no database, no worker. The local ``steer`` action and ``flow agent steer`` only relay to the hub.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from flow_sdk.builtin import agent_serve as serve
from flow_sdk.builtin import agent_steer
from flow_sdk.schema.data_spec.steer_run_spec import SteerRun, SteerStatus
from flow_sdk.schema.runtime_limits import UNATTENDED_TURN_CAP

RUN = SteerRun(agent_id="agent-a1", conversation_id="ticket-1", message_id="steer-1", text="Ask Dana for the logs")
ANSWER = "Could you send me the logs from the failing screen?"


class _Process:
    def __init__(self, count=0):
        self.context_data = {serve.UNATTENDED: count} if count else {}
        self.id = "p1"
        self.target_typeid_str = "conversation-ticket-1"

    async def save(self):
        return None


class _Engine:
    """Stands in for ``TurnEngine``: records the turns it is asked to run and answers as programmed."""

    ap = _Process()
    result = SimpleNamespace(ok=True, text=ANSWER, ran=True, busy=False, detail="")
    turns: list = []

    def __init__(self, agent, deployment):
        self.agent, self.deployment = agent, None

    async def find_process(self, session):
        return type(self).ap

    async def run(self, turn, *, process=None):
        type(self).turns.append(turn)
        return type(self).result


@pytest.fixture
def rig(monkeypatch):
    from flow_sdk.builtin import data_driver
    from flow_sdk.builtin.agent import Agent

    state = SimpleNamespace(attended=False, sent=[], mode=None)
    _Engine.ap, _Engine.turns = _Process(), []
    _Engine.result = SimpleNamespace(ok=True, text=ANSWER, ran=True, busy=False, detail="")

    async def get_by_id(agent_id):
        return SimpleNamespace(id=agent_id, typeid=f"agent-{agent_id}", name="support", reply_mode=state.mode)

    async def placement(agent, conversation_id):
        return SimpleNamespace(id="d1"), SimpleNamespace(id="s1", provider="desk")

    async def attendance(source, conversation):
        assert conversation == "ticket-1", "asked about the ticket by its id"
        return state.attended

    class Driver:
        async def send(self, row, **kw):
            state.sent.append(kw)

    monkeypatch.setattr(Agent, "get_by_id", get_by_id)
    monkeypatch.setattr(agent_steer, "placement", placement)
    monkeypatch.setattr(serve, "TurnEngine", _Engine)
    monkeypatch.setattr(serve, "driver_class", lambda source: SimpleNamespace(default_reply_mode="auto"))
    monkeypatch.setattr(serve, "attendance_of", attendance)
    monkeypatch.setattr(data_driver.DataDriver, "loaded", classmethod(lambda cls, name: Driver()))
    return state


def _steer():
    return asyncio.run(agent_steer.steer(RUN))


def test_a_steer_runs_one_admin_turn_and_sends_its_text_while_the_agent_is_alone(rig):
    outcome = _steer()
    assert outcome.status is SteerStatus.RAN
    (turn,) = _Engine.turns
    assert turn.author is serve.TurnAuthor.ADMIN and turn.key == "steer-1" and turn.body.startswith(serve.ADMIN_HEADER)
    assert rig.sent == [{"thread_key": "ticket-1", "to": "ticket-1", "text": ANSWER}]
    assert ANSWER not in outcome.model_dump_json(), "the agent's words never come back through a steer"
    assert serve.unattended_turns(_Engine.ap) == 1


def test_once_a_person_attends_the_turn_runs_and_the_customer_gets_nothing(rig):
    rig.attended = True
    assert _steer().status is SteerStatus.RAN
    assert len(_Engine.turns) == 1 and rig.sent == []


def test_the_reply_mode_decides_whatever_the_channel_default_is(rig):
    rig.mode = "never"
    assert _steer().status is SteerStatus.RAN and rig.sent == []


def test_a_redelivered_steer_is_answered_from_the_record_and_sends_nothing_again(rig):
    _Engine.result = SimpleNamespace(ok=True, text=ANSWER, ran=False, busy=False, detail="")
    assert _steer().status is SteerStatus.RAN and rig.sent == []


def test_a_busy_session_and_a_failed_turn_are_statuses(rig):
    _Engine.result = SimpleNamespace(ok=False, text="", ran=False, busy=True, detail="")
    assert _steer().status is SteerStatus.BUSY
    _Engine.result = SimpleNamespace(ok=False, text="", ran=True, busy=False, detail="the worker never came up")
    outcome = _steer()
    assert outcome.status is SteerStatus.FAILED and "never came up" in outcome.detail


def test_a_ticket_at_the_unattended_cap_is_not_run(rig):
    _Engine.ap = _Process(UNATTENDED_TURN_CAP)
    assert _steer().status is SteerStatus.CAPPED and _Engine.turns == []


def test_zero_or_several_deployments_refuse_the_steer(monkeypatch):
    from flow_sdk.builtin.agent import Agent

    async def get_by_id(agent_id):
        return SimpleNamespace(id=agent_id, typeid=f"agent-{agent_id}", name="support")

    async def none_serving():
        return []

    async def sources(agent, deployment):
        return []

    monkeypatch.setattr(Agent, "get_by_id", get_by_id)
    monkeypatch.setattr(serve, "serving_deployments", none_serving)
    monkeypatch.setattr(serve, "answered_sources", sources)
    with pytest.raises(agent_steer.SteerRefused) as refused:
        asyncio.run(agent_steer.steer(RUN))
    assert refused.value.status_code == 409


def test_the_local_steer_action_relays_to_the_hub_and_runs_nothing_here(monkeypatch):
    """A process on this machine cannot inject an admin turn: the local action is the hub's, which checks the caller
    holds admin on the agent and records the steer message before anything is delivered."""
    from flow_sdk.app.actions import agent_steer_action
    from flow_sdk.cloud_client.hub_proxy import HubProxy

    calls = []

    async def call(cls, method, entity_type, entity_id, action, **kw):
        calls.append((method, str(entity_type), entity_id, action, kw["payload"]))
        return {"message_id": "m1", "status": "sending"}

    async def post_data():
        return {"agent_id": "agent-a1", "text": "Ask Dana for the logs"}

    info = SimpleNamespace(target_entity_typeid=SimpleNamespace(id="ticket-1"), get_post_data=post_data)
    monkeypatch.setattr(HubProxy, "call", classmethod(call))
    monkeypatch.setattr(agent_steer_action, "get_current_request_info", lambda: info)
    monkeypatch.setattr(agent_steer, "steer", lambda run: pytest.fail("a local steer must not run a turn"))
    response = asyncio.run(agent_steer_action.steer_ticket())
    assert response.data == {"message_id": "m1", "status": "sending"}
    assert calls == [("POST", "conversation", "ticket-1", "steer", {"agent_id": "a1", "text": "Ask Dana for the logs"})]
