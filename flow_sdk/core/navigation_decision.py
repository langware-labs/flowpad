"""NavigationDecision: a typed request in, a dock to navigate OR a prompt for the assistant out.

    outcome = await decide({"utterance": "open data sources", "here": here})
    outcome.address   # '/dock/data-sources'  (and outcome.dock, the tab)   -- navigate
    outcome.prompt    # 'summarize the README'                              -- or ask

The input is the NavigationSpec's request (``navigator.request``: the utterance and
``navigation.here``); the output is ``navigation.outcome`` -- both defined in the SmartNavigator
dataset, so a logged decision IS a dataset row (``flow_sdk.core.navigation_log``).

The ENGINE is ``flow_sdk.core.navigator.route`` (rules, then one decision API call acted on at
>= 0.85, off without a decision API). Anything that answers ``NavigatorRoute`` can stand in for
it -- a classifier trained on the logged rows included -- and nothing above this line changes.

**The dock is built here for every target the backend can address**: a screen (its dock
address, query included), an entity (its asset editor, else the screen named after its type --
``conversation/<id>``), an app (``app/artifact-<id>``). A file, URL or web-app port leaves the
dock empty and keeps the target: the vfs and editor-for-path rules live in TypeScript
(``dockForTarget``), and a second owner of them here would drift. Every other answer -- agentic,
unsure, no decision API, a target nothing can open -- is the PROMPT: the utterance, unchanged,
for the assistant.
"""

from __future__ import annotations

import logging
from typing import Any, Awaitable, Callable, Optional

from flow_sdk.core.dock_address import VIEW_META, parse_dock_url, parse_view_type
from flow_sdk.core.navigation import kind
from flow_sdk.schema.data_spec.dock_pointer_spec import DockPointerSpec
from flow_sdk.schema.data_spec.navigator_spec import NavigationTarget, NavigatorRoute

logger = logging.getLogger(__name__)

Engine = Callable[..., Awaitable[NavigatorRoute]]
#: Targets the UI turns into a dock itself (``dockForTarget``): navigated, never a prompt.
UI_BUILT = ("file", "url", "webapp")


def decision_of(answer: NavigatorRoute) -> dict[str, Any]:
    """An engine's answer as a ``navigator.decision`` (its confidence kept; the reason is run detail)."""
    out: dict[str, Any] = {"route": answer.route, "confidence": answer.confidence}
    if answer.route == "quick" and answer.target is not None:
        out["target"] = answer.target.model_dump(mode="json")
        out["verb"] = answer.verb
    return out


def address_of(target: NavigationTarget) -> Optional[str]:
    """The dock address a target opens, or None when the backend cannot address it."""
    if target.kind == "view":
        return f"/dock/{target.value}" if parse_dock_url(f"/dock/{target.value}") else None
    if target.kind == "app":
        return f"/dock/app/artifact-{target.value}"
    if target.kind == "entity":
        from flow_sdk.core.asset_editor import editor_for_type  # noqa: PLC0415

        type_name, _, ident = target.value.partition("-")
        if (editor := editor_for_type(type_name)) is not None:
            return f"/dock/assets/editor/{editor.value}/typeid/{target.value}"
        view = parse_view_type(type_name)
        if view is not None and VIEW_META[view].addressable and VIEW_META[view].pointer.value != "none":
            return f"/dock/{view.value}/{ident}"
    return None


def _dock(address: str) -> Optional[DockPointerSpec]:
    """The tab an address opens; None for a surface that is no tab (Home is full-bleed)."""
    parsed = parse_dock_url(address)
    if parsed is None:
        return None
    try:
        return DockPointerSpec(viewType=parsed.view_type.value, pointer=parsed.pointer or "")
    except ValueError:
        return None


async def decide(request: Any, *, engine: Optional[Engine] = None) -> Any:
    """``navigator.request`` (or its dict) -> a validated ``navigation.outcome``.

    ``request.candidates`` is not a field: the engine searches, and what it offered rides back on
    the outcome. An eval passes ``engine`` bound to a row's recorded candidates.
    """
    return (await decide_run(request, engine=engine))[0]


async def decide_run(request: Any, *, engine: Optional[Engine] = None) -> tuple[Any, NavigatorRoute]:
    """``decide``, plus the engine's own answer (its ``reason`` and ``latency_ms``) for the log."""
    from flow_sdk.core.navigator import route  # noqa: PLC0415

    req = kind("navigator.request").model_validate(request)
    here = req.here.model_dump(mode="json", exclude_none=True) if req.here else None
    answer = await (engine or route)(req.utterance, here=here)
    outcome: dict[str, Any] = {"decision": decision_of(answer), "candidates": answer.offered}
    target = answer.target if answer.route == "quick" else None
    address = address_of(target) if target is not None else None
    if address:
        outcome["address"] = address
        outcome["dock"] = _dock(address)
    elif target is None or target.kind not in UI_BUILT:
        outcome["prompt"] = req.utterance
    out = kind("navigation.outcome").model_validate({k: v for k, v in outcome.items() if v is not None})
    return out, answer


__all__ = ["UI_BUILT", "address_of", "decide", "decide_run", "decision_of"]
