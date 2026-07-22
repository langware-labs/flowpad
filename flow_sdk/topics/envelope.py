"""FlowEvent — THE standard event envelope, system-wide.

Field-for-field twin of the TS interface in ``ts_sdk/src/topics/EventBus.ts``;
the shared contract fixture ``tests/fixtures/flow_event_contract.json`` pins
both sides to one JSON shape. The bus (``topics/bus.py``) routes on ``topic``
(+ optional target/scope filters) and never interprets meaning.

Distinct from ``flow_manager.envelope.RunEvent`` — that is the flow ENGINE's
run-local wiring envelope and never rides the bus.
"""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field

from flow_sdk.core.capabilities.models import now_iso
from flow_sdk.fs_store.identifier import mint_uuid

TopicOrigin = Literal["app", "local_server", "hub", "sandbox"]


class FlowEventCtx(BaseModel):
    """Correlation only — enriches, never gates. Routing NEVER reads ctx
    (except the optional scope delivery filter)."""

    # Who caused it, in target form: `user:<id>`, `agentic_process:<id>`,
    # `system`, `hub`. The one non-derivable attribution.
    actor: Optional[str] = None
    # Containment chain, innermost-first, entries in target form.
    scope: list[str] = Field(default_factory=list)
    # Which tier emitted — required; emit() fills the tier default.
    origin: TopicOrigin = "local_server"


class FlowEvent(BaseModel):
    """The envelope. ``topic`` is the only field routing ever reads."""

    # Minted at emit via the standard minter; NEVER rewritten on relay.
    id: str = Field(default_factory=lambda: str(mint_uuid()))
    # Stamped by the emitter; ordering hint, not a guarantee.
    timestamp: str = Field(default_factory=now_iso)
    # Free dot-separated ontological string — the bus never interprets it.
    topic: str
    # What the event is about: `type:id` form, or a named topic (wiki word).
    target: str
    data: dict = Field(default_factory=dict)
    ctx: FlowEventCtx = Field(default_factory=FlowEventCtx)
