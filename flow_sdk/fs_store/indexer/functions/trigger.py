"""Reader + extractor + asset-hash for TRIGGER records.

A trigger is a folder containing ``trigger.json`` — one ``TriggerSpec``: what
makes something run, and what it then does. Discovery is the generic
``repo_assets_fn`` walk, so a trigger is found both at
``<scope>/agentic-assets/trigger/*/`` and nested inside another asset's own
``agentic-assets/`` — which is how a wizard carries the trigger that launches it.

**The document is nested; the row is flat, and this module is the translation.**
``TriggerSpec`` says "exactly one of tag / schedule / watch / hook", because that
is the honest shape for four disjoint variants. The ``Trigger`` entity is thirty
optional columns with a ``trigger_type`` discriminator, because that is what a
row is and what every reader of it — ``tag_triggers.py`` reaching for
``trigger.tag_pattern`` — already expects. Flattening HERE means the document
gets the good shape and not one runtime consumer changes.

**Runtime state is never read from the document.** ``counter``, ``last_run`` and
friends live on the row (``persist=Persist.TRUE`` — the shadow record, which is
under flow home and never in git). A document that carried a counter would land
on a fresh machine already spent, so ``fire_once`` would suppress the very first
run, silently, and only on other people's machines. The spec has no such fields;
this module never sets them.

Nothing here raises. A malformed ``trigger.json`` in a cloned third-party repo
must degrade to "this folder declares no trigger", never wedge the indexer
walking a hundred other assets alongside it — and the row is still emitted,
because that row is the only way to open the thing and fix it.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional

from pydantic import ValidationError

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.functions._asset_identity import main_file_mtime
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.schema.data_spec.trigger_spec import TriggerSpec

_log = logging.getLogger(__name__)

TRIGGER_JSON = "trigger.json"


def parse_trigger(text: str) -> TriggerSpec:
    """Parse a document, RAISING on anything wrong with it.

    The half of the reader that has an opinion — what lets a caller that WANTS
    the error (a validate action, the problem reporter) get it.
    """
    return TriggerSpec.model_validate_json(text)


def read_trigger(trigger_dir: Path) -> Optional[TriggerSpec]:
    """Parse ``<dir>/trigger.json`` into a ``TriggerSpec``, or ``None``.

    The swallow is load-bearing and matches ``read_wizard``: the indexer walks a
    hundred assets in a repo someone cloned, and one bad document must not wedge
    it. What it must not be is SILENT — that is ``trigger_document_problem``.
    """
    spec, _ = read_trigger_result(trigger_dir)
    return spec


def read_trigger_result(trigger_dir: Path) -> "tuple[Optional[TriggerSpec], str]":
    """``(spec, problem)`` from ONE read and ONE parse.

    Both questions a caller can ask — *what does it say* and *why will it not
    load* — come off the same parse, so asking both costs one. Same shape as
    ``read_wizard_result``.
    """
    path = Path(trigger_dir) / TRIGGER_JSON
    try:
        return parse_trigger(path.read_text(encoding="utf-8")), ""
    except FileNotFoundError:
        return None, f"{TRIGGER_JSON} is missing"
    except OSError as exc:
        return None, f"{TRIGGER_JSON} could not be read: {exc}"
    except ValidationError as exc:
        first = exc.errors(include_url=False)[0]
        where = ".".join(str(part) for part in first.get("loc", ())) or "document"
        return None, f"{where}: {first.get('msg', 'is invalid')}"
    except ValueError as exc:
        return None, f"{TRIGGER_JSON} is not valid JSON: {exc}"


def trigger_document_problem(trigger_dir: Path) -> str:
    """Why this folder declares no trigger, in one line, or ``""``."""
    return read_trigger_result(trigger_dir)[1]


def trigger_asset_hash(ref: FSRef) -> float:
    """Freshness is the mtime of ``trigger.json``, and only that file.

    A trigger folder carries an identity capsule beside its document, and a
    capsule stamp must not read as "the trigger changed".
    """
    return main_file_mtime(ref, TRIGGER_JSON)


def row_fields(spec: TriggerSpec, *, parent_type_id: str = "") -> dict:
    """The nested document, flattened onto the row's columns.

    Pure and separately testable, because this is the whole translation and the
    place a new variant is most likely to be forgotten.
    """
    from flow_sdk.builtin.trigger import TriggerType  # noqa: PLC0415

    fields: dict = {
        "name": spec.name,
        "description": spec.description,
        "enabled": spec.enabled,
        # Firing POLICY — general, not per-kind. The entity labels these
        # "(TAG only)" because that is where they were implemented; nothing
        # about them is about the bus.
        "fire_once": spec.fire_once,
        "max_fires_per_minute": spec.max_fires_per_minute,
        "confirm": spec.confirm or None,
    }

    if spec.tag is not None:
        fields.update(
            trigger_type=TriggerType.TAG,
            tag_pattern=spec.tag.on,
            tag_target=spec.tag.target or None,
            tag_scope=list(spec.tag.scope),
        )
    elif spec.schedule is not None:
        fields.update(
            trigger_type=TriggerType.SCHEDULE,
            sched_trigger_type=spec.schedule.every,
            expr=spec.schedule.expr,
            instruction=spec.schedule.instruction or None,
            workdir=spec.schedule.workdir or None,
        )
    elif spec.watch is not None:
        fields.update(
            trigger_type=TriggerType.FSOP,
            watch_path=spec.watch.path,
            recursive=spec.watch.recursive,
            watch_glob=spec.watch.glob or None,
            respect_gitignore=spec.watch.respect_gitignore,
            ignore_patterns=list(spec.watch.ignore_patterns),
            step_ms=spec.watch.step_ms,
            debounce_ms=spec.watch.debounce_ms,
        )
    else:
        fields.update(
            trigger_type=TriggerType.HOOK,
            hook_events=list(spec.hook.events) if spec.hook else [],
            mask=dict(spec.hook.mask) if spec.hook else {},
            log_mode=spec.hook.log_mode if spec.hook else "activations",
        )

    fields["actions"] = [_action_row(a, parent_type_id=parent_type_id) for a in spec.actions]
    return fields


def _action_row(action, *, parent_type_id: str = "") -> dict:
    """One ``TriggerActionSpec`` as the row's ``TriggerAction`` shape.

    ``run_wizard`` has no ``ActionType`` of its own: it is delivered as the
    ``builtin_run_wizard`` CALLBACK the runtime already registers, with the
    wizard's TypeId on ``target_type_id``. The DOCUMENT still says "run this
    wizard" rather than naming a Python function — which is the point — and the
    row can now say WHICH, which it could not when the subject rode the
    trigger's generic ``path``.

    An EMPTY ``run_wizard`` in a trigger nested inside a wizard means "my
    parent". That is the ergonomic case and the common one: an author writing
    ``agentic-assets/trigger/on-app-ready/`` inside their wizard should not have
    to paste a uuid they do not have yet. An explicit TypeId is for a standalone
    trigger that launches something elsewhere.
    """
    from flow_sdk.builtin.hook_models import ActionType, TriggerAction  # noqa: PLC0415

    verb = action.verb
    if verb == "run_wizard":
        return TriggerAction(
            action_type=ActionType.CALLBACK,
            callback_name="builtin_run_wizard",
            target_type_id=action.run_wizard or parent_type_id or None,
        ).model_dump()
    if verb == "run_script":
        return TriggerAction(action_type=ActionType.RUN_SCRIPT, script_path=action.run_script).model_dump()
    if verb == "callback":
        return TriggerAction(action_type=ActionType.CALLBACK, callback_name=action.callback).model_dump()
    return TriggerAction(action_type=ActionType.NOTIFY_ENTITY).model_dump()


def extract_trigger(ref: FSRef, resolved_id: str) -> list[FSRecord]:
    """Parse a trigger folder into one Record row."""
    path = ref._path
    spec, problem = read_trigger_result(path) if path.is_dir() else (None, "not a folder")
    name = (spec.name if spec and spec.name else path.name)

    rec_kwargs: dict = {
        "type": RecordType.TRIGGER,
        "id": resolved_id,
        "name": name,
        "status": "active",
        "content": "\n".join(
            part for part in (name, spec.description if spec else "", _content_hint(spec)) if part
        ),
    }
    if spec is not None:
        if spec.description:
            rec_kwargs["description"] = spec.description
        # TOP LEVEL, not under `metadata`. `meta_dict` emits every non-system
        # attribute flat, and `Entity.from_record` lifts a NESTED `metadata`
        # only for names a type's `meta_model` declares — TRIGGER has none, so
        # nested fields stayed nested and the row kept its defaults. Verified
        # the hard way: the trigger indexed, and came back `trigger_type=hook`.
        rec_kwargs.update(row_fields(spec))
    rec = FSRecord(**rec_kwargs)
    object.__setattr__(rec, "_asset_ref", FSRef(path.resolve()))
    return [rec]


def _content_hint(spec: Optional[TriggerSpec]) -> str:
    """What a search should match: the thing that makes it fire."""
    if spec is None:
        return ""
    if spec.tag is not None:
        return spec.tag.on
    if spec.schedule is not None:
        return f"{spec.schedule.every} {spec.schedule.expr}"
    if spec.watch is not None:
        return spec.watch.path
    return " ".join(spec.hook.events) if spec.hook else ""
