"""The navigation map, and where the person is on it -- as the SmartNavigator dataset defines them.

Three questions, one join key (a screen's ``view`` slug):

* **the map** -- every screen a person can be on or be sent to (``navigation.map`` of
  ``navigation.place``), built here from ``VIEW_META``, the one table that knows the screens;
* **you are here** -- the place a tab is on plus the context it really provides
  (``navigation.here``), built from that tab's ``browser_context``;
* **where to go** -- ``navigator.target`` / ``navigator.route`` (``flow_sdk.core.navigator``).

The shapes are the shipped ``data_spec`` folders (``flowpad_assistant/agentic-assets/data_spec/
navigation.*``), so a row of the SmartNavigator dataset, the navigator and
``flow context list`` all speak the one definition.

**The no-stale rule.** The UI's context slots outlive the screen that set them: open an asset,
go to Events, and ``CurrentActiveEntityTypeId`` still names the asset. "Here" keeps a slot only
when the current place ``provides`` it (and, for the entity, when the address names something),
so "this" never means a thing that is no longer on screen. The project is kept on every screen.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from functools import lru_cache
from typing import Any, Mapping, Optional

from flow_sdk.core.dock_address import VIEW_META, ViewType, normalize_retired, parse_dock_url

#: The SmartNavigator dataset. It does not ship (its rows are a benchmark, not product): it lives
#: beside the checkout at ``dev/dataset/smart-navigator``, or wherever ``FLOW_NAVIGATOR_DATASET``
#: points. Its kinds DO ship -- ``flowpad_assistant/agentic-assets/data_spec/navigat*`` -- and so
#: does its eval (``flowpad_assistant/agentic-assets/eval/navigator``).
DATASET = Path(
    os.environ.get("FLOW_NAVIGATOR_DATASET") or Path(__file__).resolve().parents[3] / "dataset" / "smart-navigator"
)

logger = logging.getLogger(__name__)


def kind(name: str) -> type:
    """A ``navigation.*`` / ``navigator.*`` kind -- the dataset's definition, registered on first use."""
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415
    from flow_sdk.schema.data_spec import declared  # noqa: PLC0415

    declared.ensure_shipped()
    shape = SchemaRegistry.kind_type(name)
    if not isinstance(shape, type):
        raise LookupError(f"kind {name!r} is not registered -- is the smart-navigator dataset shipped?")
    return shape


# ── the map ──────────────────────────────────────────────────────────────────


def place_of(view: ViewType) -> dict[str, Any]:
    """One ``VIEW_META`` row as a ``navigation.place`` value."""
    meta = VIEW_META[view]
    return {
        "view": view.value,
        "label": meta.label,
        "aliases": list(meta.aliases),
        "pages": list(meta.pages),
        "pointer": meta.pointer.value,
        "pointer_form": meta.pointer_form if meta.pointer.value != "none" else None,
        "provides": list(meta.provides),
        "opens": list(meta.opens),
        "subplaces": [{"pointer": p, "label": label} for p, label in meta.subplaces],
    }


@lru_cache(maxsize=1)
def navigation_map() -> Any:
    """Every addressable screen, as a validated ``navigation.map``."""
    places = [place_of(view) for view, meta in VIEW_META.items() if meta.addressable]
    return kind("navigation.map").model_validate({"places": places})


# ── you are here ─────────────────────────────────────────────────────────────


async def _ref(typeid: Optional[str], *, path: bool = False) -> Optional[dict[str, Any]]:
    """``navigation.ref`` for a context slot: its title (and a project's folder) when it resolves."""
    if not typeid:
        return None
    out: dict[str, Any] = {"typeid": str(typeid)}
    try:
        from flow_sdk.core.entity.entity_model import Entity  # noqa: PLC0415

        ent = await Entity.get_by_typeid(str(typeid))
    except Exception as exc:  # noqa: BLE001 -- a title is a nicety; the typeid is the fact
        logger.debug("here: %s did not resolve: %s", typeid, exc)
        ent = None
    if ent is not None:
        title = getattr(ent, "name", None) or getattr(ent, "title", None)
        if title:
            out["title"] = str(title)
        mount = getattr(ent, "fs_storage_mount_path", None) if path else None
        if mount:
            out["path"] = str(mount)
    return out


async def _last_shown(process: Optional[str]) -> Optional[dict[str, Any]]:
    """The session's last display target (``context_data.last_shown``), as ``navigation.shown``."""
    if not process:
        return None
    try:
        from flow_sdk.core.entity.entity_model import Entity  # noqa: PLC0415

        ent = await Entity.get_by_typeid(process)
        shown = ((getattr(ent, "context_data", None) or {}) if ent else {}).get("last_shown")
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(shown, dict) or not shown.get("kind"):
        return None
    return {k: shown.get(k) for k in ("kind", "path", "typeid") if shown.get(k)}


async def here_from(browser_context: Mapping[str, Any]) -> Any:
    """Where a tab is: its ``browser_context`` as a validated ``navigation.here``.

    The address is ``CurrentUrl`` (path + query) when the tab sends it, else ``CurrentPathname``.
    """
    ctx = browser_context or {}
    address = str(ctx.get("CurrentUrl") or ctx.get("CurrentPathname") or "")
    parsed = parse_dock_url(address)
    here: dict[str, Any] = {"address": address or None}
    provides: tuple[str, ...] = ()
    if parsed is not None:
        view, pointer = normalize_retired(parsed.view_type, parsed.pointer)
        here.update(view=view.value, pointer=pointer, page=parsed.page.value)
        provides = VIEW_META[view].provides
    elif address.split("?", 1)[0] in ("", "/"):
        here.update(view=ViewType.HOME.value, page="desk")  # the root is Home's canonical address
    here["project"] = await _ref(ctx.get("CurrentProjectTypeId"), path=True)
    if "process" in provides:
        here["process"] = await _ref(ctx.get("CurrentProcessTypeId"))
        here["last_shown"] = await _last_shown(ctx.get("CurrentProcessTypeId"))
    if "entity" in provides and (here.get("pointer") or (parsed and parsed.options.get("focus"))):
        here["entity"] = await _ref(ctx.get("CurrentActiveEntityTypeId"))
    return kind("navigation.here").model_validate({k: v for k, v in here.items() if v is not None})


__all__ = ["DATASET", "here_from", "kind", "navigation_map", "place_of"]
