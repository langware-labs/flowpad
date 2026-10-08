"""The navigation map, and where the person is on it -- as the SmartNavigator dataset defines them.

Three questions, one join key (a screen's ``view`` slug):

* **the map** -- every screen a person can be on or be sent to (``navigation.map`` of
  ``navigation.place``), built here from ``VIEW_META``, the one table that knows the screens;
* **you are here** -- the place a tab is on plus the context it really provides
  (``navigation.here``), built from that tab's ``browser_context``;
* **where to go** -- ``navigator.target`` / ``navigator.route`` (``flow_sdk.core.navigator``).

The schemas are the shipped ``data_schema`` folders (``flowpad_assistant/agentic-assets/data_schema/
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
import re
from pathlib import Path
from functools import lru_cache
from typing import Any, Mapping, Optional

from flow_sdk.api.api_types.identifier import is_valid_uuid
from flow_sdk.core.dock_address import VIEW_META, ViewType, normalize_retired, parse_dock_url

#: The SmartNavigator dataset. It does not ship (its rows are a benchmark, not product): it lives
#: beside the checkout at ``dev/dataset/smart-navigator``, or wherever ``FLOW_NAVIGATOR_DATASET``
#: points. Its schemas DO ship -- ``flowpad_assistant/agentic-assets/data_schema/navigat*`` -- and so
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


#: Asset types with a screen of their own, not a list among the assets.
_OWN_SCREEN = ("claude_session", "codex_session", "copilot_session", "data_source", "data_driver")


def _singular(name: str) -> str:
    return name[:-1] if name.endswith("s") and not name.endswith("ss") else name


@lru_cache(maxsize=1)
def _listed_types() -> tuple[str, ...]:
    """The types the Assets screen lists (``assets/list/<type>``): the browseable types and every
    asset family -- from the type registry, so a new type is a place the day it ships."""
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    types = set(SchemaRegistry.browseable_type_names())
    types |= {t for t in SchemaRegistry.get_all_types() if getattr(SchemaRegistry.get(t), "family", None)}
    return tuple(sorted(types - set(_OWN_SCREEN)))


def _type_words(t: str) -> tuple[str, str]:
    """A listed type's display name and its own name, as words (``Documents``, ``markdown``)."""
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    return SchemaRegistry.get_display_name(t), t.replace("_", " ")


def _asset_lists() -> list[tuple[str, str]]:
    """``(list/<type>, its name)`` for every listed type."""
    out = []
    for t in _listed_types():
        shown, own = _type_words(t)
        out.append((f"list/{t}", f"Assets > my {_singular(shown)}s: the list of all my {_singular(own)}s"))
    return out


def asset_list_names() -> dict[str, str]:
    """``{name: "list/<type>"}``: the words that name a type's list on the Assets screen -- its display
    name and its type, singular and plural ("specs", "project manifest"). A request that is exactly
    one of them opens the list with no model (``navigator.rule_hit``)."""
    out: dict[str, str] = {}
    for t in _listed_types():
        for word in _type_words(t):
            singular = _singular(word.lower())
            for name in (singular, f"{singular}s"):
                out.setdefault(name, f"list/{t}")
    return out


def _driver_pages() -> list[tuple[str, str]]:
    """``data-sources/drivers/<name>`` for every shipped data driver -- its reference page."""
    from flow_sdk.ingest.driver_registry import SHIPPED_ROOT, driver_folders, read_manifest  # noqa: PLC0415

    out = []
    for folder in driver_folders(SHIPPED_ROOT):
        try:
            spec = read_manifest(folder)
        except Exception as exc:  # noqa: BLE001 -- one broken manifest is one driver page fewer
            logger.debug("map: driver %s: %s", folder.name, exc)
            continue
        out.append((f"drivers/{spec.name}", f"Data sources > drivers > {spec.name}: the reference page of the {spec.title or spec.name} driver"))
    return out


# ── addresses on the map ─────────────────────────────────────────────────────


def place_address(place: Any, pointer: str = "") -> str:
    """A place's address, or one of its subplaces': a ``?`` pointer is the screen's options, a ``/``
    one a whole address of its own (a projection the hub renders)."""
    if pointer.startswith("/"):
        return pointer[1:]
    prefix = "hub/" if list(place.pages) == ["hub"] else ""
    sep = "" if not pointer or pointer.startswith("?") else "/"
    return f"{prefix}{place.view}{sep}{pointer}"


#: ``<name>`` is filled from the entity; ``<name=value>`` only matches an entity whose ``name`` IS
#: ``value`` (``<harness=claude>/tasks/<session>``: Claude Code alone keeps a todo list).
_PLACEHOLDER = re.compile(r"<(\w+)(?:=([\w\-]+))?>")


def open_form(form: str, ref: Mapping[str, Any]) -> Optional[str]:
    """``form`` filled from an entity in context, or None when it needs something the context
    does not carry -- an option is never offered for an address the app cannot open."""
    kind_, _, ident = str(ref.get("typeid") or "").partition("-")
    known = {**{k: str(v) for k, v in ref.items() if v}, "id": ident, "type": kind_}
    # A path is a pointer segment: written without its leading slash (``vfs/<path>``).
    known = {k: v.lstrip("/") if k.endswith("path") else v for k, v in known.items()}
    for name, value in _PLACEHOLDER.findall(form):
        if name not in known or (value and known[name] != value):
            return None
    return _PLACEHOLDER.sub(lambda m: known[m.group(1)], form)


def forms_for(entity_type: str) -> list[tuple[Any, str, str]]:
    """``(place, pointer form, name)`` for every way a screen opens on an entity of ``entity_type``."""
    return _forms_by_type().get(entity_type, [])


@lru_cache(maxsize=1)
def _forms_by_type() -> dict[str, list[tuple[Any, str, str]]]:
    out: dict[str, list[tuple[Any, str, str]]] = {}
    for place in navigation_map().places:
        for of_kind, form, what in VIEW_META[ViewType(place.view)].open_forms:
            out.setdefault(of_kind, []).append((place, form, what))
    return out


#: Places whose subplaces are generated from what ships (types, drivers), beside ``VIEW_META``'s own.
_GENERATED_SUBPLACES = {ViewType.ASSETS: _asset_lists, ViewType.DATA_SOURCES: _driver_pages}


def place_of(view: ViewType) -> dict[str, Any]:
    """One ``VIEW_META`` row as a ``navigation.place`` value."""
    meta = VIEW_META[view]
    subplaces = [*meta.subplaces, *(_GENERATED_SUBPLACES[view]() if view in _GENERATED_SUBPLACES else ())]
    return {
        "view": view.value,
        "label": meta.label,
        "aliases": list(meta.aliases),
        "pages": list(meta.pages),
        "pointer": meta.pointer.value,
        "pointer_form": meta.pointer_form if meta.pointer.value != "none" else None,
        "provides": list(meta.provides),
        "opens": list(meta.opens),
        "subplaces": [{"pointer": p, "label": label} for p, label in subplaces],
    }


@lru_cache(maxsize=1)
def navigation_map() -> Any:
    """Every addressable screen, as a validated ``navigation.map``."""
    places = [place_of(view) for view, meta in VIEW_META.items() if meta.addressable]
    return kind("navigation.map").model_validate({"places": places})


# ── you are here ─────────────────────────────────────────────────────────────


async def _ref(typeid: Optional[str], *, path: bool = False, extras: bool = False) -> Optional[dict[str, Any]]:
    """``navigation.ref`` for a context slot: its title (and a project's folder) when it resolves.
    ``extras``: what the navigator's openings need beyond that (a session's harness, session id and
    live session; a project's room) -- extra queries nobody else pays for."""
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
        # An alias (``project-@local``) names the row; the ref carries the row's own id, so every
        # address built from it is one the app can open.
        out["typeid"] = f"{str(typeid).partition('-')[0]}-{ent.id}"
        title = getattr(ent, "name", None) or getattr(ent, "title", None)
        if title:
            out["title"] = str(title)
        mount = getattr(ent, "fs_storage_mount_path", None) if path else None
        if mount:
            out["path"] = str(mount)
        if extras and str(typeid).startswith("agentic_process-"):
            out.update(await _session_of(ent))
        if extras and str(typeid).startswith("project-") and (room := await _room_of(ent)):
            out["room"] = room
        if str(typeid).startswith("data_source-") and (provider := getattr(ent, "provider", None)):
            out["provider"] = str(provider)
    return out


async def _room_of(project: Any) -> Optional[str]:
    """The project's active collaboration room, when it has one -- where "open the room" goes."""
    try:
        from flow_sdk.builtin.collaboration_room import CollaborationRoom, CollaborationRoomStatus  # noqa: PLC0415

        rooms = await CollaborationRoom.get_all({"project_id": str(project.id)})
    except Exception as exc:  # noqa: BLE001 -- a room is a nicety; the project is the fact
        logger.debug("here: rooms of %s: %s", getattr(project, "id", "?"), exc)
        return None
    active = [r for r in rooms if getattr(r, "status", None) == CollaborationRoomStatus.ACTIVE]
    return str(active[0].id) if active else None




async def _session_of(process: Any) -> dict[str, str]:
    """What a session in context carries beyond its id: its harness and its own session id (what
    its transcript is filed under), and the live session it is shared in now, when it is."""
    from flow_sdk.flowpad_types.vendors import vendor_or_none  # noqa: PLC0415

    out: dict[str, str] = {}
    # The vendor's key is how the transcript viewers name a harness (``lens/<harness>/transcript/...``).
    if vendor := vendor_or_none(getattr(process, "worker_type", None)):
        out["harness"] = vendor.key
    if session := getattr(process, "session_id", None):
        out["session"] = str(session)
    if plan := getattr(process, "plan_path", None):
        out["plan_path"] = str(plan)
    try:
        from flow_sdk.builtin.remote_worker_session import RemoteWorkerSession, is_terminal  # noqa: PLC0415

        live = [
            s
            for s in await RemoteWorkerSession.get_all({"host_process_id": str(process.id)})
            if not is_terminal(getattr(s, "status", None))
        ]
    except Exception as exc:  # noqa: BLE001 -- the live session is a nicety; the session is the fact
        logger.debug("here: live session of %s: %s", getattr(process, "id", "?"), exc)
        live = []
    if live:
        out["live_session"] = str(live[0].id)
    return out


async def _recent_session(project: Optional[str]) -> Optional[dict[str, Any]]:
    """The most recently used session of the project -- what "resume my last chat" opens."""
    if not project:
        return None
    try:
        from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess  # noqa: PLC0415
        from flow_sdk.db.drivers.query import QueryFilter  # noqa: PLC0415

        rows = await AgenticProcess.get_all(
            QueryFilter(match={"project_id": project.partition("-")[2]}, order_by=[{"updated_date": "desc"}], limit=1)
        )
    except Exception as exc:  # noqa: BLE001 -- a nicety; without it the request is the assistant's
        logger.debug("here: recent session of %s: %s", project, exc)
        return None
    return await _ref(f"agentic_process-{rows[0].id}", extras=True) if rows else None


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


def _shown_in(view: Optional[str], pointer: Optional[str], options: Mapping[str, str]) -> Optional[dict[str, str]]:
    """What the address itself names, read by the screen's own ``open_forms`` -- ``trigger/log/<id>``,
    ``?trigger=<id>``, ``<harness>/transcript/<session>`` -- as ``{"type": ..., <placeholder>: value}``.
    The address is the truth; the tab's active-entity slot may be left over from an earlier screen."""
    if not view:
        return None
    for of_kind, form, _ in VIEW_META[ViewType(view)].open_forms:
        if form.startswith("?"):
            key, _, template = form[1:].partition("=")
            subject, pattern = options.get(key), template
        else:
            subject, pattern = pointer, form
        if subject and (m := _form_regex(pattern).fullmatch(subject)):
            return {"type": of_kind, **m.groupdict()}
    return None


@lru_cache(maxsize=None)
def _form_regex(form: str) -> "re.Pattern[str]":
    """An open form as the pattern that reads it back: ``<name>`` a segment (a ``…path`` any rest),
    ``<name=value>`` that value only."""

    def group(m: "re.Match[str]") -> str:
        name, value = m.group(1), m.group(2)
        body = re.escape(value) if value else (".+" if name.endswith("path") else "[^/]+")
        return f"(?P<{name}>{body})"

    return re.compile(_PLACEHOLDER.sub(group, re.escape(form)))


async def _shown_ref(shown: dict[str, str]) -> Optional[str]:
    """The typeid an address names: by its ``<id>``, or a session by its harness session id."""
    if ident := shown.get("id"):
        return f"{shown['type']}-{ident}" if is_valid_uuid(ident) else None
    session = shown.get("session")
    if shown["type"] == "agentic_process" and session:
        try:
            from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess  # noqa: PLC0415
            from flow_sdk.db.drivers.query import QueryFilter  # noqa: PLC0415

            rows = await AgenticProcess.get_all(QueryFilter(match={"session_id": session}, limit=1))
        except Exception as exc:  # noqa: BLE001 -- a nicety; the address still says where they are
            logger.debug("here: session %s: %s", session, exc)
            return None
        return f"agentic_process-{rows[0].id}" if rows else None
    return None


def place_for(view: Optional[str]) -> Any:
    """The map's place for a view, or None (a view that is no place)."""
    return _places_by_view().get(view)


@lru_cache(maxsize=1)
def _places_by_view() -> dict[str, Any]:
    return {p.view: p for p in navigation_map().places}


@lru_cache(maxsize=None)
def filter_keys(view: Optional[str]) -> frozenset[str]:
    """The query options a screen declares as filters: its sub-places' (``runs?status=failed``) and
    its open forms' (``?trigger=<id>``) -- what it shows, unlike how the tab is shown (``viewMode``)."""
    from urllib.parse import parse_qsl  # noqa: PLC0415

    place = place_for(view)
    keys = {k for s in (place.subplaces if place else ()) for k, _ in parse_qsl(s.pointer.partition("?")[2])}
    keys |= {form[1:].partition("=")[0] for _, form, _ in (VIEW_META[ViewType(view)].open_forms if view else ()) if form.startswith("?")}
    return frozenset(keys)


@lru_cache(maxsize=None)
def _subplace_pointers(view: Optional[str]) -> frozenset[str]:
    place = place_for(view)
    return frozenset(s.pointer for s in place.subplaces) if place else frozenset()


async def here_from(browser_context: Mapping[str, Any], *, navigator: bool = False) -> Any:
    """Where a tab is: its ``browser_context`` as a validated ``navigation.here``.

    The address is ``CurrentUrl`` (path + query) when the tab sends it, else ``CurrentPathname``.
    ``navigator``: also what the navigator's openings need (the recent session, a session's live
    session, a project's room) -- extra queries ``flow context`` does not pay for.
    """
    import asyncio  # noqa: PLC0415

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
    # What is open: the pointer, a focus, or the option a screen selects an entity with
    # (``automations?trigger=<id>``, from its ``open_forms``).
    selects = {"focus"} | {
        form[1:].split("=", 1)[0]
        for _, form, _ in (VIEW_META[ViewType(here["view"])].open_forms if here.get("view") else ())
        if form.startswith("?")
    }
    process = ctx.get("CurrentProcessTypeId") if "process" in provides else None
    # A pointer that is one of the screen's own sub-places (``assets/list/task``) names a place, not
    # an entity: the tab's active entity is then left over from an earlier screen.
    pointer = here.get("pointer")
    names_one = bool(pointer) and pointer not in _subplace_pointers(here.get("view"))
    opened = "entity" in provides and (names_one or (parsed and any(parsed.options.get(o) for o in selects)))
    entity = ctx.get("CurrentActiveEntityTypeId") if opened else None
    shown = _shown_in(here.get("view"), pointer, parsed.options) if parsed is not None else None

    async def nothing() -> None:
        return None

    # First the project (the recent session is looked up by its own id, never by an alias the tab
    # may send: ``project-@local``) and what the address names; then the rest, which need them.
    here["project"], named = await asyncio.gather(
        _ref(ctx.get("CurrentProjectTypeId"), path=True, extras=navigator),
        _shown_ref(shown) if shown else nothing(),
    )
    project = (here["project"] or {}).get("typeid")
    # What the address names wins over the slot: a session's transcript is that session, a
    # trigger's log is that trigger, whatever the tab last set.
    if named and named.startswith("agentic_process-"):
        process = named
    elif named and named != project:
        entity = named
    here["recent"], here["process"], here["last_shown"], here["entity"] = await asyncio.gather(
        _recent_session(project) if navigator else nothing(),
        _ref(process, extras=navigator) if process else nothing(),
        _last_shown(process) if process else nothing(),
        _ref(entity) if entity else nothing(),
    )
    return kind("navigation.here").model_validate({k: v for k, v in here.items() if v is not None})


__all__ = ["DATASET", "forms_for", "here_from", "kind", "navigation_map", "filter_keys", "open_form", "place_address", "place_for", "place_of"]
