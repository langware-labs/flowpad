"""Harness selection state for bootstrap — all the math, in Python.

The UI renders this verbatim (no client-side detection). ``compute_harness_state``
lists every concrete harness capability with its discovered install status +
install-page link, marks the default, and decides whether the UI should pop the
harness-select dialog (``show_harness_select``).

Source of truth is the capability-discovery dict (see discovery.py) — the same
values workers spawn with — so what the dialog shows matches reality.
"""

from __future__ import annotations

import logging

from flow_sdk.core.capabilities.discovery import ensure_discovered, get_capability_value
from flow_sdk.core.capabilities.models import CapabilityKind
from flow_sdk.core.capabilities.registry import get_capability_registry

logger = logging.getLogger(__name__)


def _is_installed(kind: str) -> bool:
    value = get_capability_value(kind)
    return value is not None and value.value is not None


async def compute_harness_state(wait_for_discovery: bool = True) -> dict:
    """Bootstrap harness state: the list of harnesses + the select-dialog flag.

    Returns ``{"show_harness_select": bool, "harnesses": [{kind, name,
    installed, homepage_url, is_default}, …]}``. ``show_harness_select`` is true
    when the default harness (the ``harness`` reference's target) is not
    installed — which also covers "nothing installed at all".

    ``wait_for_discovery=False`` (the cold-bootstrap fast path) skips the
    ~860ms env-probe sweep and reports from what's been discovered so far; the
    sweep already runs as a startup task and the UI reads harness state from
    its own live ``capabilityManager`` subscription, not this snapshot.
    """
    if wait_for_discovery:
        try:
            await ensure_discovered()
        except Exception:
            logger.exception("compute_harness_state: capability discovery failed")
    registry = get_capability_registry()

    # Default-harness resolution + availability come from the reference check:
    # it resolves the user-selected ``reference_kind`` and reports available iff
    # that concrete harness has a discovered value.
    default_kind: str | None = None
    show_harness_select = True
    try:
        chk = await registry.test(CapabilityKind.HARNESS.value)
        default_kind = chk.result.details.get("reference_kind")
        show_harness_select = not chk.result.available
    except Exception:
        logger.exception("compute_harness_state: harness reference check failed")

    harnesses = []
    for spec in registry.matching_specs("harness"):
        if spec.kind == CapabilityKind.HARNESS.value:
            continue  # the reference pointer itself, not a concrete harness
        harnesses.append(
            {
                "kind": spec.kind,
                "name": spec.name,
                "installed": _is_installed(spec.kind),
                "homepage_url": spec.homepage_url,
                "is_default": spec.kind == default_kind,
            }
        )

    return {"show_harness_select": show_harness_select, "harnesses": harnesses}
