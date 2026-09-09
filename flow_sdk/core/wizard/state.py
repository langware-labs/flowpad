"""One wizard's run state on disk: the inputs it has been given, and where it got to.

Deliberately a JSON file rather than an entity, and the lock rule is what makes
that enough. One run per named wizard means one file per wizard: no run id to
invent, no ``WizardRun`` type, no second meaning for a name the frontend already
uses (``ui/src/hooks/use-wizard-run.ts`` exports its own ``WizardRun``).

It has to survive a restart for one specific reason: a wizard's trigger is
``fire_once``, so it will not fire again. A run parked at boot waiting for an
answer would otherwise be lost on the next restart and the wizard would never
run at all — resumption comes from ``set_input``, not from the trigger.

Written through ``instances/atomic`` (fsync-before-rename) and mutated under its
file lock, because ``set_input`` and a concurrent re-run both touch it.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

from flow_sdk.instances.atomic import locked, read_json, write_json_atomic

#: The status vocabulary lives in ONE place — ``runner.py``, which mints the
#: values. A second copy here was dead and, being a copy, free to drift into a
#: rival answer to "what can a run rest in".

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


def read_inputs(wizard_id: str) -> dict[str, Any]:
    """Just the name→value dict."""
    values = read_state(wizard_id).get("inputs")
    return dict(values) if isinstance(values, dict) else {}


def _mutate(wizard_id: str, fields: "Callable[[dict], dict]") -> dict:
    """Read-modify-write the run file under its lock, and return the new state.

    The ONE place the locking discipline is written. Every writer here is the
    same three steps — take the lock, fold some fields into what is on disk,
    write atomically — and stating that four times is how a fifth writer ends up
    quietly skipping the lock. ``fields`` receives the current state so a writer
    that MERGES (inputs) can read what it is merging into.
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


def set_input(wizard_id: str, name: str, value: Any) -> dict[str, Any]:
    """Merge one answer in, atomically. Returns the new input dict.

    Under the file lock: a person answering while a re-run is writing its
    outcomes must not lose either write.
    """
    def merge(state: dict) -> dict:
        inputs = dict(state.get("inputs") or {})
        inputs[name] = value
        return {"inputs": inputs}

    return _mutate(wizard_id, merge)["inputs"]


def clear_inputs(wizard_id: str) -> None:
    """Forget every answer — the affordance behind "run it again from scratch"."""
    if _state_path(wizard_id).exists():
        _mutate(wizard_id, lambda _state: {"inputs": {}})


def record_approval(wizard_id: str) -> None:
    """Remember that a person approved THIS wizard's run.

    A non-system wizard needs approval before it runs shell. Without recording
    it, a run that parks for a value can never be resumed: ``set-input`` would
    have to re-ask for approval on every answer, because the approval lived only
    in the body of the first POST. Recorded per wizard, so it is auditable and
    can be cleared, rather than inferred.
    """
    _mutate(wizard_id, lambda _state: {"approved": True})


def is_approved(wizard_id: str) -> bool:
    return bool(read_state(wizard_id).get("approved"))


def record_result(wizard_id: str, *, status: str, awaiting: list, outcomes: list,
                  message: str = "") -> None:
    """Stamp what the last run did. Inputs are preserved — they are the user's,
    not the run's, and a re-run must not have to ask twice."""
    _mutate(wizard_id, lambda _state: {
        "status": status, "awaiting": awaiting, "outcomes": outcomes, "message": message,
    })


def input_env(inputs: dict[str, Any]) -> dict[str, str]:
    """Inputs as environment for a command step.

    ENV, never interpolation. Substituting a value into a shell one-liner would
    make an input of ``; rm -rf /`` executable — straight through the trust gate
    that decides whether this wizard may run shell at all. As env, an answer can
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
