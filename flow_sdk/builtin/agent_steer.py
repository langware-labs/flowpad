"""Steer: an admin's message into the process of the agent working one ticket, with a status back and never its words.

``steer(run)`` runs one steer on this machine. Its only caller is the box route (``server/routes/agent_steer.py``),
which only the hub's hop reaches: the hub checks that the caller holds ``admin`` on the agent, writes the steer message
into the ticket's team conversation and relays it here (``flow agent steer`` and the desktop's ``steer`` action go
through the hub, so no local process can inject an admin turn). It finds the ONE deployment on this machine that
answers the ticket's channel (zero or several: refused -- two deployments must not answer one desk), runs one
``TurnAuthor.ADMIN`` turn in the ticket's session (the process is started when none exists), counts it against the
unattended cap, and sends the turn's text to the ticket only when the agent's reply mode says so
(:func:`flow_sdk.builtin.agent_serve.may_speak`). The outcome carries a status; the text is never returned.
"""

from __future__ import annotations

import logging

from flow_sdk.builtin import agent_serve as serve
from flow_sdk.schema.data_spec.steer_run_spec import SteerOutcome, SteerRun, SteerStatus

logger = logging.getLogger(__name__)

#: How much of a refusal's reason a steer may carry back: a status line, never an agent's answer.
_DETAIL_MAX = 200


class SteerRefused(Exception):
    """The steer cannot be placed (no such agent or ticket, no single deployment answering it)."""

    def __init__(self, message: str, status_code: int):
        super().__init__(message)
        self.status_code = status_code


async def placement(agent, conversation_id: str):
    """``(deployment, source)``: the one local deployment of *agent* answering the ticket's channel, and that channel."""
    from flow_sdk.builtin.conversation import Conversation  # noqa: PLC0415

    conversation = await Conversation.get_by_id(conversation_id)
    wanted = str(getattr(conversation, "channel_source_id", "") or "")
    found: list[tuple] = []
    for deployment in await serve.serving_deployments():
        if str(deployment.main_agent_id or "") != str(agent.typeid):
            continue
        sources = [s for s in await serve.answered_sources(agent, deployment) if not wanted or str(s.id) == wanted]
        if len(sources) > 1:
            raise SteerRefused("more than one channel of this agent answers that ticket", 409)
        if sources:
            found.append((deployment, sources[0]))
    if len(found) != 1:
        raise SteerRefused(
            f"{len(found)} deployments on this machine answer that ticket; steering needs exactly one", 409
        )
    return found[0]


def _short(text: object) -> str:
    return " ".join(str(text or "").split())[:_DETAIL_MAX]


async def steer(run: SteerRun) -> SteerOutcome:
    """Run one admin turn for the ticket's agent. Raises :class:`SteerRefused` when it cannot be placed."""
    from flow_sdk.builtin.agent import Agent  # noqa: PLC0415
    from flow_sdk.builtin.data_driver import DataDriver  # noqa: PLC0415
    from flow_sdk.fs_store.type_id import TypeId  # noqa: PLC0415
    from flow_sdk.schema.types import EntityType  # noqa: PLC0415

    agent = await Agent.get_by_id(run.agent_id.removeprefix("agent-"))
    if agent is None:
        raise SteerRefused("no such agent", 404)
    deployment, source = await placement(agent, run.conversation_id)
    engine = serve.TurnEngine(agent, deployment)
    session = str(TypeId(type=EntityType.CONVERSATION.value, id=run.conversation_id))

    attended = await serve.attendance_of(source, run.conversation_id)
    ap = await engine.find_process(session)
    await serve.note_attendance(ap, attended)
    if serve.at_cap(ap, attended):
        await serve.flag_cap_once(engine, ap)
        return SteerOutcome(status=SteerStatus.CAPPED, detail=serve.CAP_REACHED)
    outcome = await engine.run(
        serve.Turn(
            session=session,
            key=run.message_id,
            body=serve.steer_body(run.text),
            name=f"{agent.name} · steer",
            author=serve.TurnAuthor.ADMIN,
        )
    )
    if getattr(outcome, "busy", False):
        return SteerOutcome(status=SteerStatus.BUSY, detail="another turn holds the ticket's session")
    if not outcome.ok:
        return SteerOutcome(status=SteerStatus.FAILED, detail=_short(outcome.detail))
    if not getattr(outcome, "ran", True):
        return SteerOutcome(status=SteerStatus.RAN, detail="already run: answered from the turn record")
    await serve.count_unattended(await engine.find_process(session), attended)
    # Decided after the turn, right before the send: a person may have picked the ticket up while it ran.
    if outcome.text and await serve.may_speak(agent, source, run.conversation_id):
        try:
            driver = DataDriver.loaded(str(source.provider))
            await driver.send(source, thread_key=run.conversation_id, to=run.conversation_id, text=outcome.text)
        except Exception as e:  # noqa: BLE001 — a refused send is a status, not a crash
            logger.warning("steer: the turn ran but its reply was not sent: %s", e)
            return SteerOutcome(
                status=SteerStatus.FAILED, detail=f"the turn ran; sending its reply failed: {_short(e)}"
            )
    return SteerOutcome(status=SteerStatus.RAN)
