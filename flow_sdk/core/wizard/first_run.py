"""The first-run wizard as a gate: project setup begins only after it.

The first-run wizard (``llm-setup``) installs the tools Flowpad leans on. Setting a project up before it
has been through leaves the project asking for tools nothing has offered to install yet, and its own
dialogs landing on top of the wizard's.

**"Done" is a durable fact of the instance, not the last run's answer.** ``run.json`` is archived on every
start (``reset_run``), and a run that a person declined or that a policy blocked never ends all green; a
gate on the last answer would close again on every "Run setup again" and could never open for them. So
``first_run_done`` is stamped once -- when a run ends all OK, even if the window was closed meanwhile -- and
survives every later run.

Open (``first_run_gate_open``) when any of these holds, and closed otherwise:

* ``first_run_done`` is stamped;
* a result is on disk from before runs were tracked (``first_run_tracked`` unset): an install that already
  ran the wizard is not asked to again;
* the person went on without finishing it THIS session (``waive_for_session``): a waiver lives in this process
  only, so the wizard opens again after a restart -- it is never a permanent way round;
* ``FLOWPAD_SKIP_FIRST_RUN_SETUP=true`` (a test backend never runs the wizard);
* the box was launched by the hub (its template carries the tools; the wizard runs itself there, off screen);
* the wizard is not installed, or its state cannot be read -- a gate that cannot tell stays open and says so
  in the log, because a closed gate nobody can open is a stuck user.

**A wizard that is not indexed YET is not "not installed".** On a fresh database the shipped wizard's row appears
only when the system-content index ends -- some 40 seconds after the app is serving -- and a gate that read "no
wizard" as open let a project setup (and an invitation's dialog) through in that window. Until the index ends
the gate is closed, and ``first_run_state`` does not answer at all: it waits, event-driven (no polling, no
timeout), for the index to end, and only then says whether the gate is open.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import TYPE_CHECKING

from flow_sdk.core.wizard.state import (
    FIRST_RUN_DONE,
    FIRST_RUN_TRACKED,
    mark_first_run_done,
    mark_first_run_tracked,
    read_state,
)

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.builtin.wizard import Wizard
    from flow_sdk.responses.response import ApiFailResponse
    from flow_sdk.schema.data_spec.returned_value_spec import WizardResult

_log = logging.getLogger(__name__)

#: Whether the system-content index (which creates the shipped wizard's row) is still running in this process.
#: Set by the server around its index task; a process that never indexes (a CLI, a test) never sets it, and
#: for it "no wizard row" keeps meaning "this install has none".
_INDEXING = False
_INDEXED: asyncio.Event | None = None

#: Wizard ids whose gate the person opened for this session ("Continue anyway"). In memory on purpose: a restart
#: forgets it, so the wizard comes back until it has run fully.
_WAIVED: set[str] = set()

#: The shipped first-run wizard, by name.
FIRST_RUN_WIZARD = "llm-setup"
#: Skips the first-run trigger on a test backend; the gate honours the same switch.
SKIP_FIRST_RUN_SETUP_ENV = "FLOWPAD_SKIP_FIRST_RUN_SETUP"
#: What a refused request carries (``data.blocked``) so a client can tell this refusal from any other.
BLOCKED_FIRST_RUN = "first_run_setup"
BLOCKED_MESSAGE = "Finish the first-time setup before setting up a project."


class FirstRunSetupRequired(Exception):
    """Project setup was asked for before the first-run wizard was done."""

    def __init__(self) -> None:
        super().__init__(BLOCKED_MESSAGE)


def first_run_gate_open(wizard_id: str, name: str = FIRST_RUN_WIZARD) -> bool:
    """Whether project setup may begin, judged for the wizard ``wizard_id`` (named ``name``).

    Any wizard but the first-run one is open: only that wizard gates anything. Never raises."""
    if name != FIRST_RUN_WIZARD:
        return True
    try:
        if os.environ.get(SKIP_FIRST_RUN_SETUP_ENV, "").lower() == "true":
            return True
        from flow_sdk.instance_settings.runtime import get_assigned_runtime  # noqa: PLC0415

        if get_assigned_runtime() is not None:
            return True
        if wizard_id in _WAIVED:
            return True
        state = read_state(wizard_id)
        if state.get(FIRST_RUN_DONE):
            return True
        # A result written before runs were tracked: this install already ran the wizard.
        return isinstance(state.get("result"), dict) and not state.get(FIRST_RUN_TRACKED)
    except Exception:  # noqa: BLE001 -- a gate that cannot tell stays open (and says so)
        _log.warning("first-run gate: could not read the wizard's state; leaving the gate open", exc_info=True)
        return True


async def first_run_wizard() -> "Wizard | None":
    """The first-run wizard's row, or ``None`` when this install does not ship it."""
    from flow_sdk.builtin.wizard import Wizard  # noqa: PLC0415

    try:
        return await Wizard.by_name(FIRST_RUN_WIZARD)
    except Exception:  # noqa: BLE001 -- unreadable index: the gate stays open
        _log.warning("first-run gate: could not look up the wizard; leaving the gate open", exc_info=True)
        return None


def indexing_started() -> None:
    """The server scheduled its system-content index: until it ends, a missing wizard row means "not yet"."""
    global _INDEXING, _INDEXED
    _INDEXING = True
    _INDEXED = asyncio.Event()


def indexing_finished() -> None:
    """The system-content index ended (done, failed or cancelled -- all of them end the wait)."""
    global _INDEXING
    _INDEXING = False
    if _INDEXED is not None:
        _INDEXED.set()


async def wait_until_indexed() -> None:
    """Return once the shipped wizards can be looked up. Event-driven: no polling and no timeout."""
    if _INDEXING and _INDEXED is not None:
        await _INDEXED.wait()


async def first_run_state() -> str:
    """``"open"`` or ``"closed"``: whether project setup may begin, answered once the wizard CAN be looked up.

    What the app asks at load: a UI that decided on "no wizard row" before the index ended would call the gate
    open for good. Waits for the index (see the module doc), then judges like ``require_first_run_setup``."""
    await wait_until_indexed()
    wizard = await first_run_wizard()
    return "open" if wizard is None or first_run_gate_open(str(wizard.id), wizard.name) else "closed"


async def require_first_run_setup() -> None:
    """Raise ``FirstRunSetupRequired`` unless project setup may begin. The one check every door calls."""
    wizard = await first_run_wizard()
    if wizard is None:
        # No row YET (the index is still running) is not "no wizard here": the gate stays closed until it ends.
        if _INDEXING:
            _log.info("first-run gate: closed -- the shipped wizards are not indexed yet")
            raise FirstRunSetupRequired()
        return
    if first_run_gate_open(str(wizard.id), wizard.name):
        return
    _log.info("first-run gate: closed -- project setup refused until the first-run wizard is done")
    raise FirstRunSetupRequired()


async def first_run_block() -> "ApiFailResponse | None":
    """The refusal an action answers with while the gate is closed, or ``None`` when setup may begin.

    412 (a precondition not met) with ``data.blocked == "first_run_setup"``: a client tells it from any other
    refusal by that, and shows "finish the first-time setup" instead of an error. Not 409 -- clients already
    read a 409 from these very routes as a NAME COLLISION (``project_name_conflict``, a clone's suggested name)."""
    from flow_sdk.responses.response import ApiFailResponse  # noqa: PLC0415

    try:
        await require_first_run_setup()
    except FirstRunSetupRequired:
        return ApiFailResponse(message=BLOCKED_MESSAGE, status_code=412, data={"blocked": BLOCKED_FIRST_RUN})
    return None


def waive_for_session(wizard_id: str) -> None:
    """The person chose to go on without finishing the wizard: open the gate until this process ends."""
    _WAIVED.add(str(wizard_id))
    _log.info("first-run gate: waived for this session (continue without finishing)")


def begin_first_run(wizard: "Wizard") -> None:
    """Called as a start of the first-run wizard begins, BEFORE its last run is cleared.

    An install that ran the wizard before runs were tracked keeps its standing: its old result is stamped
    ``first_run_done`` now, because the start that follows archives that result. Then the run is marked
    tracked, so from here a result on disk (a run still going writes one) proves nothing -- only the stamp."""
    if wizard.name != FIRST_RUN_WIZARD:
        return
    wid = str(wizard.id)
    if first_run_gate_open(wid, wizard.name) and wid not in _WAIVED:
        mark_first_run_done(wid)
    mark_first_run_tracked(wid)


def finish_first_run(wizard: "Wizard", result: "WizardResult") -> bool:
    """Called when a start of the first-run wizard has run to its end, after every step AND the
    sign-in that follows the installs. All green opens the gate for good -- also when the person closed the
    window meanwhile and the installs finished in the background; anything else leaves it as it was.

    Returns whether it stamped, so the caller can tell the watchers the gate changed."""
    if wizard.name != FIRST_RUN_WIZARD or not result.ok:
        return False
    mark_first_run_done(str(wizard.id))
    _log.info("first-run gate: opened -- the first-run wizard finished")
    return True
