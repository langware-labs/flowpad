"""FlowEvent — THE standard event envelope, system-wide.

Field-for-field twin of the TS interface in ``ts_sdk/src/tags/EventBus.ts``;
the shared contract fixture ``tests/fixtures/flow_event_contract.json`` pins
both sides to one JSON shape. The bus (``tags/bus.py``) routes on ``tag``
(+ optional target/scope filters) and never interprets meaning.

Distinct from ``graph_workflow_manager.envelope.RunEvent`` — that is the flow ENGINE's
run-local wiring envelope and never rides the bus.
"""
from __future__ import annotations

import re
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


def now_iso() -> str:
    """ISO-8601 UTC timestamp. Deliberately local (not imported from
    capabilities.models, its historical home): capabilities.models now imports
    the tags grammar, so importing back from here is a circular import that
    breaks server boot."""
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()
from flow_sdk.api.api_types.identifier import UUID_PATTERN, mint_uuid

TagOrigin = Literal["app", "local_server", "hub", "sandbox"]


def target_of(entity_type: str, entity_id: str) -> str:
    """THE owner of the normative colon target form (``type:id``).

    Deliberately NOT ``TypeId`` serialization — TypeId renders with a DASH
    (``type-id``); the bus grammar is colon-separated (docs/tags.md). Every
    emitter builds targets/scope entries through here so the two forms can
    never silently drift."""
    return f"{entity_type}:{entity_id}"


# A TypeId serializes as ``type-<uuid>``, and BOTH halves may contain hyphens
# ("compute-node-<uuid>"), so the uuid suffix — not the first or last hyphen —
# is the only reliable boundary.
_UUID_SUFFIX_RE = re.compile(
    r"^(.+)-(" + UUID_PATTERN + r")$",
    re.IGNORECASE,
)


def parse_target(target: Any) -> tuple[Optional[str], Optional[str]]:
    """THE inverse of :func:`target_of` — ``(entity_type, entity_id)`` or
    ``(None, None)``.

    Accepts every spelling that reaches a wire boundary:

    * ``"type:id"``       — the normative colon target form;
    * ``"type-<uuid>"``   — TypeId serialization, including hyphenated type
      names ("compute-node-<uuid>"), resolved on the trailing uuid;
    * ``"type-rest"``     — anything else with a hyphen, split at the first one
      (named ids such as ``skill-my-skill``);
    * a mapping with ``type``/``id`` keys, or any object carrying those attrs.

    Nothing else parses; the caller decides whether ``(None, None)`` is fatal.
    """
    if isinstance(target, str):
        match = _UUID_SUFFIX_RE.match(target)
        if match:
            return match.group(1), match.group(2)
        if ":" in target:
            etype, eid = target.split(":", 1)
            return etype or None, eid or None
        if "-" in target:
            etype, eid = target.split("-", 1)
            return etype or None, eid or None
        return None, None
    if isinstance(target, dict):
        return target.get("type"), target.get("id")
    if hasattr(target, "type") and hasattr(target, "id"):
        return target.type, target.id
    return None, None


class FlowEventCtx(BaseModel):
    """Correlation only — enriches, never gates. Routing NEVER reads ctx
    (except the optional scope delivery filter)."""

    # Who caused it, in target form: `user:<id>`, `agentic_process:<id>`,
    # `system`, `hub`. The one non-derivable attribution.
    actor: Optional[str] = None
    # Containment chain, innermost-first, entries in target form.
    scope: list[str] = Field(default_factory=list)
    # Which tier emitted — REQUIRED on the wire (mirror of the TS contract:
    # no model default). The BUS stamps its tier default at emit() — the
    # envelope model stays tier-agnostic (a worker/sandbox flow_sdk must not
    # silently self-label local_server).
    origin: TagOrigin


class FlowEvent(BaseModel):
    """The envelope. ``tag`` is the only field routing ever reads."""

    # Minted at emit via the standard minter; NEVER rewritten on relay.
    id: str = Field(default_factory=lambda: str(mint_uuid()))
    # Stamped by the emitter; ordering hint, not a guarantee.
    timestamp: str = Field(default_factory=now_iso)
    # Free dot-separated ontological string — the bus never interprets it.
    tag: str
    # What the event is about: `type:id` form, or a named tag (wiki word).
    target: str
    data: dict = Field(default_factory=dict)
    ctx: FlowEventCtx = Field(default_factory=FlowEventCtx)
