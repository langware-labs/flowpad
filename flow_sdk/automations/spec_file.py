"""Editing an automation that is DEFINED IN A FILE — its ``trigger.json``.

A trigger asset's document is the truth; its row is the index. ``Trigger.update``
writes the row only, so an edit made that way is reverted by the next re-index —
which is why the agent Schedule tab has its own writer (``agent_schedule``).
This is the same move for any automation the screen edits: apply the person's
field changes to the DOCUMENT (keeping everything they did not touch), validate
it as a ``TriggerSpec``, write it, and re-index (which re-arms).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from flow_sdk.schema.data_spec.trigger_spec import TriggerSpec


class SpecFileError(ValueError):
    """An edit the file cannot take. ``status_code`` rides to HTTP."""

    def __init__(self, message: str, status_code: int = 422):
        super().__init__(message)
        self.status_code = status_code


def document_path(trigger: Any) -> Path | None:
    """The automation's ``trigger.json``, when it has one on disk."""
    from flow_sdk.assets.types.trigger import TRIGGER_JSON  # noqa: PLC0415

    ref = str(getattr(trigger, "asset_ref", "") or "")
    if not ref:
        return None
    path = Path(ref) / TRIGGER_JSON
    return path if path.is_file() else None


def _action_doc(action: dict[str, Any], parent_type_id: str) -> dict[str, Any]:
    """One row action (``TriggerAction`` dict) as a document action."""
    kind = str(action.get("action_type") or "")
    target = str(action.get("target_type_id") or "")
    if kind == "run_agent":
        # Empty agent = "my parent", as the document spells it.
        agent = "" if target and target == parent_type_id else target
        return {"run_agent": {"agent": agent, "prompt": str(action.get("prompt") or "")}}
    if kind == "run_script":
        return {"run_script": str(action.get("script_path") or action.get("script_filename") or "")}
    if kind == "notify_entity":
        return {"notify_entity": target}
    if kind == "callback":
        name = str(action.get("callback_name") or "")
        if name == "builtin_run_wizard":  # "open this wizard", the document's run_wizard verb
            return {"run_wizard": "" if target == parent_type_id else target}
        return {"callback": name}
    raise SpecFileError(f"An automation file cannot hold a {kind or 'blank'} step.")


def apply_patch(doc: dict[str, Any], patch: dict[str, Any], *, parent_type_id: str = "") -> dict[str, Any]:
    """The document with the row-field ``patch`` applied. Fields not in the patch survive."""
    out = dict(doc)
    for key in ("name", "description", "enabled", "fire_once", "max_fires_per_minute"):
        if key in patch:
            out[key] = patch[key]
    if any(k in patch for k in ("tag_pattern", "tag_target", "tag_scope")):
        tag = dict(out.get("tag") or {})
        if "tag_pattern" in patch:
            tag["on"] = patch["tag_pattern"] or ""
        if "tag_target" in patch:
            tag["target"] = patch["tag_target"] or ""
        if "tag_scope" in patch:
            tag["scope"] = list(patch["tag_scope"] or [])
        out["tag"] = tag
    if any(k in patch for k in ("expr", "sched_trigger_type", "timezone")):
        schedule = dict(out.get("schedule") or {})
        if "expr" in patch:
            schedule["expr"] = patch["expr"] or ""
        if "sched_trigger_type" in patch:
            schedule["every"] = patch["sched_trigger_type"] or "cron"
        if "timezone" in patch:
            schedule["timezone"] = patch["timezone"] or ""
        schedule.setdefault("every", "cron")
        out["schedule"] = schedule
    if any(k in patch for k in ("watch_path", "recursive", "watch_glob")):
        watch = dict(out.get("watch") or {})
        if "watch_path" in patch:
            watch["path"] = patch["watch_path"] or ""
        if "recursive" in patch:
            watch["recursive"] = bool(patch["recursive"])
        if "watch_glob" in patch:
            watch["glob"] = patch["watch_glob"] or ""
        out["watch"] = watch
    if "hook_events" in patch:
        hook = dict(out.get("hook") or {})
        hook["events"] = list(patch["hook_events"] or [])
        out["hook"] = hook
    if "actions" in patch:
        out["actions"] = [_action_doc(a if isinstance(a, dict) else a.model_dump(mode="json"), parent_type_id)
                          for a in patch["actions"] or []]
    if "gate" in patch:
        out.pop("if", None)
        if patch["gate"]:
            out["if"] = gate_doc(patch["gate"])
    if "then" in patch:
        out.pop("then", None)
        if patch["then"]:
            out["then"] = patch["then"] if isinstance(patch["then"], dict) else patch["then"].model_dump(mode="json", exclude_defaults=True)
            out.pop("actions", None)
    return out


def gate_doc(gate: Any) -> Any:
    """The row's ``gate`` as the document's ``if``: the sentence a person typed when the op is
    the one-question default it was worded from, else the op itself."""
    data = gate if isinstance(gate, dict) else gate.model_dump(mode="json")
    sentence = str(data.get("sentence") or "")
    questions = data.get("questions") or {}
    require = data.get("require") or {}
    if sentence and not questions:
        return sentence  # a sentence nothing worded yet: the file keeps the person's words
    if sentence and list(questions) == ["match"] and list(require) == ["match"] and (require["match"] or {}).get("yes") == 0.85:
        return sentence
    return {k: v for k, v in data.items() if k in ("questions", "require", "input", "sentence") and v not in (None, "", {})}


def validate(doc: dict[str, Any]) -> TriggerSpec:
    from pydantic import ValidationError  # noqa: PLC0415

    try:
        spec = TriggerSpec.model_validate(doc)
    except ValidationError as exc:
        first = exc.errors(include_url=False)[0]
        where = ".".join(str(p) for p in first.get("loc", ())) or "automation"
        raise SpecFileError(f"{where}: {first.get('msg', 'is invalid')}") from exc
    if spec.schedule is not None:
        from flow_sdk.builtin.trigger import _schedule_problem  # noqa: PLC0415

        problem = _schedule_problem(spec.schedule.expr, spec.schedule.every, spec.schedule.timezone or None)
        if problem:
            raise SpecFileError(problem)
    return spec


async def rewrite(trigger: Any, patch: dict[str, Any]) -> Any:
    """Apply ``patch`` to the automation's file, write it, re-index. Returns the fresh row."""
    from flow_sdk.builtin.agent_schedule import ScheduleError, _index, _write  # noqa: PLC0415

    path = document_path(trigger)
    if path is None:
        raise SpecFileError("This automation has no file to edit.", status_code=409)
    try:
        base = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise SpecFileError(f"Cannot read {path}: {exc}", status_code=409) from exc
    spec = validate(apply_patch(base if isinstance(base, dict) else {}, patch,
                                parent_type_id=str(trigger.parent_type_id or "")))
    _write(path.parent, spec)
    try:
        return await _index(path.parent, owner=trigger)
    except ScheduleError as exc:
        raise SpecFileError(str(exc), status_code=exc.status_code) from exc
