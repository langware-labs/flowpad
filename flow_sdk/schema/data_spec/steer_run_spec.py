"""What travels to a machine to steer one ticket's agent, and what comes back (never the agent's words)."""

from __future__ import annotations

from enum import StrEnum

from flow_sdk.schema.data_spec.spec import DataSpec


class SteerStatus(StrEnum):
    """How a steer ended on the machine: the turn ran, another held the session, it failed, or the unattended cap held it."""

    RAN = "ran"
    BUSY = "busy"
    FAILED = "failed"
    CAPPED = "capped"


class SteerRun(DataSpec):
    """One admin message for the agent working a ticket. ``message_id`` names THIS steer: a redelivery of it is
    answered from the turn record, never run again."""

    agent_id: str
    conversation_id: str
    message_id: str
    text: str


class SteerOutcome(DataSpec):
    """The status of a steer, and a short reason when it did not run. Never the text the agent wrote."""

    status: SteerStatus
    detail: str = ""
