"""Scheduled agent runs — a schedule is a child trigger ASSET of the agent.

    agentic-assets/agent/<name>/agentic-assets/trigger/<slug>/trigger.json

holding a ``schedule`` block and one ``run_agent`` action whose empty ``agent``
means "my parent". Nothing about it is special once written: the indexer indexes
it (recursively, like a wizard's own trigger), ``arm_after_index`` registers the
APScheduler job, and a fire dispatches ``RUN_AGENT`` — so the schedule runs on
whichever machine indexed the agent, a deployed sandbox included.

This module is the single WRITER of that document, for three reasons the
generic routes cannot serve: ``Trigger.create`` mints file-less rows,
``Trigger.update`` is row-only (the next re-index reverts it), and ``fs/write``
resyncs with ``mint=False``, so a new ``trigger.json`` written from the UI would
never be indexed or armed.
"""
from __future__ import annotations

import asyncio
import json
import logging
import shutil
from pathlib import Path
from typing import TYPE_CHECKING, Any, Optional

from pydantic import ValidationError

from flow_sdk.schema.data_spec.trigger_spec import TriggerSpec

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.builtin.agent import Agent
    from flow_sdk.builtin.trigger import Trigger

logger = logging.getLogger(__name__)

TRIGGER_FAMILY = "trigger"
SCHEDULE_KINDS = ("cron", "interval", "date")


class ScheduleError(ValueError):
    """A schedule request the caller has to fix. ``status_code`` rides to HTTP."""

    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


def agent_folder(agent: "Agent") -> Path:
    """The agent's own folder — where its child assets nest."""
    ref = str(getattr(agent, "asset_ref", "") or "")
    if not ref:
        raise ScheduleError(f"agent {agent.name!r} has no folder on disk", status_code=409)
    path = Path(ref)
    return path.parent if path.suffix == ".md" else path


def _document(body: dict[str, Any], base: Optional[dict[str, Any]]) -> dict[str, Any]:
    """The trigger document with the request's fields applied, field by field.

    Only the fields a schedule manages are touched; anything a person authored
    by hand in ``base`` (a second action, a description, ``fire_once``) survives
    an edit from the UI.
    """
    doc = dict(base or {})
    schedule = dict(doc.get("schedule") or {})
    actions = list(doc.get("actions") or [])
    index = next((i for i, a in enumerate(actions) if isinstance(a, dict) and "run_agent" in a), None)
    run_agent = dict(actions[index]["run_agent"] or {}) if index is not None else {}

    for key in ("name", "description"):
        if key in body:
            doc[key] = str(body[key] or "").strip()
    if "enabled" in body:
        doc["enabled"] = bool(body["enabled"])
    for key in ("every", "expr", "timezone"):
        if key in body:
            schedule[key] = str(body[key] or "").strip()
    if "runs_on" in body:
        runs_on = str(body["runs_on"] or "").strip()
        if runs_on:
            schedule["runs_on"] = runs_on
        else:
            schedule.pop("runs_on", None)
    if "prompt" in body:
        run_agent["prompt"] = str(body["prompt"] or "").strip()

    schedule.setdefault("every", "cron")
    doc["schedule"] = schedule
    entry = {"run_agent": run_agent}
    if index is None:
        actions.append(entry)
    else:
        actions[index] = entry
    doc["actions"] = actions
    return doc


def _validate(doc: dict[str, Any]) -> TriggerSpec:
    """Parse the document AND the clock, so a bad cron fails the save, not the fire."""
    try:
        spec = TriggerSpec.model_validate(doc)
    except ValidationError as exc:
        first = exc.errors(include_url=False)[0]
        where = ".".join(str(part) for part in first.get("loc", ())) or "schedule"
        raise ScheduleError(f"{where}: {first.get('msg', 'is invalid')}") from exc
    if spec.schedule is None:
        raise ScheduleError("this trigger is not a schedule")
    if spec.schedule.every not in SCHEDULE_KINDS:
        raise ScheduleError(f"every must be one of {', '.join(SCHEDULE_KINDS)}")
    from flow_sdk.builtin.trigger import _parse_trigger  # noqa: PLC0415

    try:
        _parse_trigger(spec.schedule.every, spec.schedule.expr, spec.schedule.timezone or None)
    except Exception as exc:  # noqa: BLE001 — APScheduler raises ValueError/ZoneInfo errors alike
        raise ScheduleError(f"invalid {spec.schedule.every} schedule {spec.schedule.expr!r}: {exc}") from exc
    return spec


def _write(folder: Path, spec: TriggerSpec) -> None:
    from flow_sdk.assets.types.trigger import TRIGGER_JSON  # noqa: PLC0415

    text = json.dumps(spec.model_dump(mode="json", exclude_defaults=True), indent=2) + "\n"
    (folder / TRIGGER_JSON).write_text(text, encoding="utf-8")


async def _index(folder: Path, *, owner: "Optional[Trigger]" = None) -> "Trigger":
    """Index the folder now — which also arms it (``arm_after_index``)."""
    from flow_sdk.builtin.trigger import Trigger  # noqa: PLC0415
    from flow_sdk.fs_store.resolve import index_one, resolve_asset  # noqa: PLC0415

    resolved = await resolve_asset(
        folder, write=True, type_name=TRIGGER_FAMILY, strict=True,
        owner_id=str(owner.id) if owner is not None else None,
    )
    record = await index_one(
        resolved, notify=True,
        scope=owner.scope if owner is not None else None,
        project_id=owner.project_id if owner is not None else None,
    )
    if record is not None:
        # Stamp the index sentinel, as the walk does after its commit. Without
        # it the first GET of this trigger sees a stale hash and re-syncs the
        # record from disk — a redundant write that also re-arms the job.
        try:
            record.ensure_asset_ref().write_hash()
        except Exception:  # noqa: BLE001 — freshness is an optimisation, never fail the save
            logger.debug("schedule %s: could not stamp the index sentinel", folder, exc_info=True)
    trigger = await Trigger.get_by_id(str(record.id)) if record is not None else None
    if trigger is None:
        raise ScheduleError(f"schedule at {folder} did not index", status_code=500)
    return trigger


async def _owned(agent: "Agent", trigger_id: str) -> "Trigger":
    from flow_sdk.builtin.trigger import Trigger  # noqa: PLC0415

    trigger = await Trigger.get_by_id(str(trigger_id or "")) if trigger_id else None
    if trigger is None or trigger.parent_type_id != str(agent.typeid) or not trigger.asset_ref:
        raise ScheduleError("schedule not found on this agent", status_code=404)
    return trigger


async def _check_place(agent: "Agent", body: dict[str, Any]) -> None:
    """A schedule's ``runs_on`` must be one of this agent's own places."""
    runs_on = str(body.get("runs_on") or "").strip()
    if not runs_on:
        return
    from flow_sdk.builtin.agent_places import place_of  # noqa: PLC0415

    if await place_of(agent, runs_on) is None:
        raise ScheduleError(f"{runs_on} is not a place this agent runs on", status_code=404)


async def add_schedule(agent: "Agent", body: dict[str, Any]) -> "Trigger":
    """Write a new schedule under the agent and index + arm it."""
    from flow_sdk.assets.creation import (  # noqa: PLC0415
        AssetPathCollisionError,
        assert_create_target_available,
        creation_reservation,
        folder_slug,
    )
    from flow_sdk.assets.placement import AGENTIC_ASSETS_DIR  # noqa: PLC0415
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    name = str(body.get("name") or "").strip()
    if not name:
        raise ScheduleError("name is required")
    await _check_place(agent, body)
    spec = _validate(_document({**body, "name": name}, None))
    folder = agent_folder(agent) / AGENTIC_ASSETS_DIR / TRIGGER_FAMILY / folder_slug(name.lower(), "schedule")
    info = SchemaRegistry.get(TRIGGER_FAMILY)
    try:
        with creation_reservation(info, folder):
            assert_create_target_available(info, folder, entity_type="schedule", name=name)
            folder.mkdir(parents=True, exist_ok=True)
            _write(folder, spec)
            return await _index(folder)
    except AssetPathCollisionError as exc:
        raise ScheduleError(str(exc), status_code=409) from exc


async def update_schedule(agent: "Agent", trigger_id: str, body: dict[str, Any]) -> "Trigger":
    """Rewrite the managed fields of one of the agent's schedules, then re-index
    (which re-arms: the job is replaced, and paused when disabled)."""
    from flow_sdk.assets.types.trigger import TRIGGER_JSON  # noqa: PLC0415

    trigger = await _owned(agent, trigger_id)
    await _check_place(agent, body)
    folder = Path(trigger.asset_ref)
    try:
        base = json.loads((folder / TRIGGER_JSON).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ScheduleError(f"cannot read {folder / TRIGGER_JSON}: {exc}", status_code=409) from exc
    spec = _validate(_document(body, base if isinstance(base, dict) else None))
    _write(folder, spec)
    return await _index(folder, owner=trigger)


async def remove_schedule(agent: "Agent", trigger_id: str) -> None:
    """Disarm, remove the folder, then the row — in that order, or the indexer
    resurrects a row whose folder is still on disk."""
    from flow_sdk.builtin.trigger_arming import disarm_trigger  # noqa: PLC0415

    trigger = await _owned(agent, trigger_id)
    await disarm_trigger(str(trigger.id))
    folder = Path(trigger.asset_ref)
    if folder.exists():
        await asyncio.to_thread(shutil.rmtree, folder)
    await trigger.delete()
