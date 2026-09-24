"""One wizard's run state on disk: whether a person approved it, and its last answer.

Deliberately a JSON file rather than an entity, and the lock rule is what makes
that enough. One run per named wizard means one file per wizard: no run id to
invent, no ``WizardRun`` type, no second meaning for a name the frontend already
uses (``ui/src/hooks/use-wizard-run.ts`` exports its own ``WizardRun``).

The file holds two things: ``approved`` (a fact about the wizard) and
``result`` — the last run's ``WizardResult``, dumped as-is. There is no other
run shape: an older ``run.json`` (status / outcomes / awaiting) is read as "no
run yet", and the next run replaces it.

Written through ``instances/atomic`` (fsync-before-rename) and mutated under its
file lock, because an approval and a finishing run both touch it.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, Optional

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.schema.data_spec.returned_value_spec import WizardResult

from flow_sdk.instances.atomic import locked, read_json, write_json_atomic

STATE_FILENAME = "run.json"


def run_dir(wizard_id: str) -> Path:
    """This wizard's run folder — also the cwd its command steps execute in."""
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    return Path(get_instance_settings().flow_home) / "wizard-runs" / str(wizard_id)


def _state_path(wizard_id: str) -> Path:
    return run_dir(wizard_id) / STATE_FILENAME


#: ``wizard_id -> (mtime_ns, size, state)``. Bounded by the number of wizards on
#: the machine, which is the number of wizard assets — small and not attacker-
#: controlled — so it needs no eviction policy.
_CACHE: "dict[str, tuple[int, int, dict[str, Any]]]" = {}


def read_state(wizard_id: str) -> dict[str, Any]:
    """The whole state object; ``{}`` when missing or corrupt. Never raises.

    Cached on the file's (mtime, size), because this is on a SERIALIZATION path:
    ``Wizard.run_state`` is a ``@computed_field``, so a plain read here is one
    open+parse **per row** of ``GET /graph/wizard`` and again on every WS entity
    push — synchronous file I/O on the event loop for a value that changes only
    when a run does. A repeat read is now a ``stat``.

    Keyed on size as well as mtime because a coarse filesystem clock can leave
    two writes inside one mtime tick; the state file changes length whenever its
    contents do (statuses and outcome lists are never the same width twice).
    """
    path = _state_path(wizard_id)
    try:
        stat = path.stat()
        stamp = (stat.st_mtime_ns, stat.st_size)
    except OSError:
        # No file is the common case — a wizard that has never run. Cache the
        # absence too, or the fast path is exactly the one that never hits.
        stamp = (0, -1)

    hit = _CACHE.get(wizard_id)
    if hit is not None and hit[0] == stamp[0] and hit[1] == stamp[1]:
        return hit[2]

    state = read_json(path)
    _CACHE[wizard_id] = (stamp[0], stamp[1], state)
    return state


def _mutate(wizard_id: str, fields: "Callable[[dict], dict]") -> dict:
    """Read-modify-write the run file under its lock, and return the new state.

    The ONE place the locking discipline is written. Every writer here is the
    same three steps — take the lock, fold some fields into what is on disk,
    write atomically — and stating that per writer is how the next one ends up
    quietly skipping the lock.
    """
    path = _state_path(wizard_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    with locked(path.with_suffix(".lock")):
        state = read_json(path)
        state.update(fields(state))
        write_json_atomic(path, state)
        # This process just changed the file; do not make the next reader wait
        # for a stat to notice. Every writer funnels through here, so this is
        # the one invalidation point.
        _CACHE.pop(wizard_id, None)
        return state


def reset_run(wizard_id: str) -> Optional[dict[str, Any]]:
    """Archive this wizard's run and start its record fresh. ``None`` if running.

    Archive-then-fresh, never destructive — the shape `Journey.restart` uses
    (``journeys.py``: the journal is archived, not deleted, so history stays
    resumable). A debugger's reset button is exactly where someone will lose the
    evidence they were about to read.

    **Approval is always preserved**, and there is deliberately no flag to say
    otherwise. It records that a person trusts THIS WIZARD to run shell on this
    machine, which is a fact about the wizard, not about one run's answers.
    Reset means "forget this run", not "revoke consent" — revocation is a
    separate, separately-labelled verb, so a `keep_approval=False` here would be
    a second behaviour nothing asks for and nobody sees.

    **One lock acquisition, and it is not `_mutate`'s.** `_mutate` locks
    ``run_dir/run.lock`` — the SAME file `execute_wizard` holds for the whole
    run — so calling it from inside our own acquisition is a nested acquire on
    two `FileLock` objects over one path, which deadlocks. Non-blocking for the
    same reason the runner's is: a caller must be told "it is running" now, not
    queued behind it.
    """
    from filelock import FileLock, Timeout  # noqa: PLC0415

    path = _state_path(wizard_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    lock = FileLock(str(path.with_suffix(".lock")))
    try:
        lock.acquire(blocking=False)
    except Timeout:
        return None
    try:
        previous = read_json(path)
        if path.exists():
            history = path.parent / "history"
            history.mkdir(parents=True, exist_ok=True)
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f")
            os.replace(path, history / f"run-{stamp}.json")
        fresh: dict[str, Any] = {}
        if previous.get("approved"):
            fresh["approved"] = True
        write_json_atomic(path, fresh)
        # `_mutate` owns the only other invalidation, and we deliberately did
        # not go through it.
        _CACHE.pop(wizard_id, None)
        return fresh
    finally:
        lock.release()


def archived_runs(wizard_id: str) -> list[str]:
    """Archived run filenames, newest first. Empty when none."""
    history = _state_path(wizard_id).parent / "history"
    if not history.is_dir():
        return []
    return sorted((p.name for p in history.glob("run-*.json")), reverse=True)


def read_result(wizard_id: str) -> "Optional[WizardResult]":
    """The last run's answer, or ``None`` — never run, or a record in a shape
    this version does not write. Never raises."""
    from flow_sdk.schema.data_spec.returned_value_spec import WizardResult  # noqa: PLC0415

    raw = read_state(wizard_id).get("result")
    if not isinstance(raw, dict):
        return None
    try:
        return WizardResult.model_validate(raw)
    except Exception:  # noqa: BLE001 — an unreadable record is "no run", not a crash
        return None


def record_result(wizard_id: str, result: "WizardResult") -> None:
    """Stamp what the last run answered — the ``WizardResult``, each step's
    output kept to its last ``OUTPUT_CAP`` characters.

    This is where output is trimmed: a result a caller READS arrives whole, and
    one written to disk must not grow by whatever a command printed.
    """
    dumped = result.trimmed().model_dump(mode="json")
    _mutate(wizard_id, lambda _state: {"result": dumped})


#: Step fields that carry OUTPUT rather than a verdict — what `strip_heavy` drops.
_HEAVY = ("stdout", "stderr", "text", "value")


def strip_heavy(result: dict[str, Any]) -> dict[str, Any]:
    """A dumped ``WizardResult`` WITHOUT its steps' output.

    `Wizard.run_state` is a computed field, so it rides the payload of every row
    of ``GET /graph/wizard`` and every WS entity push. What a command printed and
    what a step returned are for one wizard a person is actively debugging;
    ``run-detail`` serves them whole.
    """
    def light(answer: Any) -> Any:
        if not isinstance(answer, dict):
            return answer
        out = {k: v for k, v in answer.items() if k not in _HEAVY}
        if isinstance(out.get("check"), dict):
            out["check"] = light(out["check"])
        if isinstance(out.get("steps"), dict):
            out["steps"] = {key: light(step) for key, step in out["steps"].items()}
        return out

    return light(result)


def record_approval(wizard_id: str) -> None:
    """Remember that a person approved THIS wizard's run.

    A non-system wizard needs approval before it runs shell. Recorded per
    wizard, so a trigger or a second run does not have to ask again, and so it
    is auditable and can be cleared, rather than inferred.
    """
    _mutate(wizard_id, lambda _state: {"approved": True})


def is_approved(wizard_id: str) -> bool:
    return bool(read_state(wizard_id).get("approved"))


def input_env(inputs: dict[str, Any]) -> dict[str, str]:
    """A step's values as environment for the op it calls.

    ENV, never interpolation. Substituting a value into a shell one-liner would
    make an input of ``; rm -rf /`` executable — straight through the trust gate
    that decides whether this wizard may run shell at all. As env, a value can
    change a command's environment and never which command runs.
    """
    out: dict[str, str] = {}
    for name, value in (inputs or {}).items():
        key = "FLOWPAD_WIZARD_INPUT_" + "".join(
            ch if ch.isalnum() else "_" for ch in str(name).upper()
        )
        out[key] = value if isinstance(value, str) else _json(value)
    return out


def _json(value: Any) -> str:
    import json  # noqa: PLC0415

    try:
        return json.dumps(value)
    except (TypeError, ValueError):
        return str(value)
