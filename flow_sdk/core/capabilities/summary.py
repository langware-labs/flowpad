"""One-shot capabilities summary — "all capabilities + how to access each".

The single source of truth behind ``getCapabilitiesSummary()`` (Python here,
mirrored 1:1 in TS). A pure projection over the three existing stores — the
registry (specs + dependency cascade), the discovery dict (typed values), and
the Capability entity rows (live ``reference_kind`` + last install process) —
shaped for direct rendering. Same pattern as ``compute_harness_state``: the
backend does all the math, the UI just renders.

Grouped by **intent** = ``kind.split(".")[0]`` — the segment-1 handle that
``capability_kind_matches`` already keys on, so grouping introduces no new
ontology (see CapabilityKind's docstring).
"""

from __future__ import annotations

import logging

from pydantic import BaseModel, Field

from flow_sdk.core.capabilities.discovery import ensure_discovered, get_capability_value
from flow_sdk.core.capabilities.models import (
    CapabilityKind,
    is_mcp_capability_kind,
    now_iso,
)
from flow_sdk.core.capabilities.registry import get_capability_registry

logger = logging.getLogger(__name__)


class CapabilityDependency(BaseModel):
    kind: str
    available: bool


class CapabilityAccess(BaseModel):
    """One capability + everything the UI needs to show/use it."""

    kind: str
    intent: str
    name: str
    description: str = ""
    icon: str = "BadgeCheck"
    available: bool = False
    checked: bool = False
    # Four-state readiness from the persisted row (CapabilityState value);
    # "none" until the row exists / has ever been stamped.
    state: str = "none"
    runnable: bool = True
    installable: bool = False
    worker_type: str | None = None
    homepage_url: str | None = None
    reference_kind: str | None = None
    dependencies: list[CapabilityDependency] = Field(default_factory=list)
    value: object | None = None
    value_type: str | None = None
    last_process_id: str | None = None
    message: str = ""


class CapabilityIntent(BaseModel):
    """All capabilities that answer one intent (segment-1 handle)."""

    intent: str
    label: str
    available: bool = False
    capabilities: list[CapabilityAccess] = Field(default_factory=list)


class CapabilitiesSummary(BaseModel):
    intents: list[CapabilityIntent] = Field(default_factory=list)
    capabilities: list[CapabilityAccess] = Field(default_factory=list)
    generated_at: str = Field(default_factory=now_iso)


def _intent_label(intent: str) -> str:
    return intent.replace("_", " ").title()


def _worker_type_for(kind: str) -> str | None:
    """The worker_type an MCP kind targets (its third segment); None otherwise."""
    if is_mcp_capability_kind(kind):
        parts = kind.split(".")
        return parts[2] if len(parts) >= 3 else None
    return None


def _last_process_id(row) -> str | None:
    if row is None:
        return None
    for field in ("last_install", "last_test", "last_check"):
        result = getattr(row, field, None)
        if isinstance(result, dict) and result.get("process_id"):
            return result["process_id"]
    return None


async def compute_capabilities_summary(wait_for_discovery: bool = True) -> CapabilitiesSummary:
    """Project every registered capability into a render-ready summary.

    Runs MCP reconcile + discovery first so dynamic leaves and their values are
    current, then for each kind resolves availability (with its dependency
    cascade), the discovered value, and the live entity-row metadata.

    ``wait_for_discovery=False`` (the cold-bootstrap fast path) skips the
    MCP-reconcile + ~860ms env-probe sweep and projects over what's been
    discovered so far; both already run as startup tasks and the frontend
    self-heals via capability-row ``data_op`` updates + its own ``ensureChecked``.
    """
    from flow_sdk.builtin.capability import Capability
    from flow_sdk.core.capabilities.mcp import reconcile_mcp_capabilities

    if wait_for_discovery:
        try:
            await reconcile_mcp_capabilities()
        except Exception:
            logger.exception("compute_capabilities_summary: MCP reconcile failed")
        try:
            await ensure_discovered()
        except Exception:
            logger.exception("compute_capabilities_summary: discovery failed")

    registry = get_capability_registry()
    rows = {row.kind: row for row in await Capability.get_all()}

    accesses: list[CapabilityAccess] = []
    for kind in registry.kinds():
        spec = registry.get(kind).spec
        row = rows.get(kind)
        intent = kind.split(".")[0]

        try:
            check = await registry.check(kind)
        except Exception:
            logger.exception("compute_capabilities_summary: check failed for %s", kind)
            continue

        deps = [
            CapabilityDependency(kind=dep_kind, available=result.available)
            for dep_kind, result in check.dependencies.items()
        ]
        value = get_capability_value(kind)
        reference_kind = (
            (row.reference_kind if row is not None else None) or spec.reference_kind
        )
        # Installable = something the install / intent flow can actually act on:
        # CLI harnesses + the harness reference (value_type "folder") and runnable
        # MCP connectors. Status/probe-only capabilities (browsing) are not.
        installable = spec.runnable and (
            spec.value_type is not None
            or is_mcp_capability_kind(kind)
            or reference_kind is not None
        )

        accesses.append(
            CapabilityAccess(
                kind=kind,
                intent=intent,
                name=spec.name,
                description=spec.description,
                icon=spec.icon,
                available=check.result.available,
                # The summary always runs check() for every kind, so a result is
                # always a determination — an unavailable CLI reads "Unavailable",
                # not "Not checked".
                checked=True,
                # Row state is authoritative (it encodes "never tried"); fall
                # back to deriving from this fresh check for rows not yet
                # stamped (derive without a row can't promote to NOT_AVAILABLE).
                state=(
                    row.state
                    if row is not None
                    else ("available" if check.result.available else "none")
                ),
                runnable=spec.runnable,
                installable=installable,
                worker_type=_worker_type_for(kind),
                homepage_url=spec.homepage_url,
                reference_kind=reference_kind,
                dependencies=deps,
                value=value.value if value is not None else None,
                value_type=spec.value_type,
                last_process_id=_last_process_id(row),
                message=check.result.message,
            )
        )

    accesses.sort(key=lambda a: a.kind)

    intents: dict[str, CapabilityIntent] = {}
    for access in accesses:
        group = intents.get(access.intent)
        if group is None:
            group = CapabilityIntent(
                intent=access.intent, label=_intent_label(access.intent)
            )
            intents[access.intent] = group
        group.capabilities.append(access)
        # An intent is available if any runnable leaf under it is available.
        if access.available and access.runnable:
            group.available = True

    # Stable, useful order: the harness intent first, then alphabetical.
    ordered = sorted(
        intents.values(),
        key=lambda g: (g.intent != CapabilityKind.HARNESS.value, g.intent),
    )
    return CapabilitiesSummary(intents=ordered, capabilities=accesses)
