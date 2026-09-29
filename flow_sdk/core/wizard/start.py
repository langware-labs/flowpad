"""Starting a wizard from the person's side: its page, its LLM source, its run.

What the wizard's `open` / `start` actions and its trigger callbacks share. A wizard's document
says what it needs (``requires_llm_source``); nothing here names a particular wizard.
"""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.builtin.wizard import Wizard
    from flow_sdk.schema.data_spec.returned_value_spec import CliResult, ReturnedValue, WizardResult

_log = logging.getLogger(__name__)


async def _resolve_llm_source() -> "CliResult":
    """`flow llm set auto`, run IN this process. Idempotent: it returns at once
    when the box is already funded, without opening anything.

    In-process, not a `flow` subprocess. The command is only this backend's own
    resolver plus a socket back to it, and a subprocess made the person pay a
    fresh shell and a cold ``flow_sdk`` import before the chooser appeared — on
    Windows ~3s (PowerShell, then ~1000 modules), a visible pause between the
    wizard page opening and the chooser. The resolver is synchronous and blocks
    on the chooser's socket, so it runs on a worker thread; its HTTP calls come
    back to this loop, which stays free to serve them.

    ``project_id=""`` is the box, which is what the subprocess answered too: it
    ran from the home directory, and the server's own working directory says
    nothing about what the person meant.
    """
    import typer  # noqa: PLC0415

    from flow_sdk.cli.commands import llm_cmd  # noqa: PLC0415
    from flow_sdk.schema.data_spec.compute_op_spec import CLI_TIMEOUT  # noqa: PLC0415
    from flow_sdk.schema.data_spec.returned_value_spec import CliResult  # noqa: PLC0415

    try:
        row = await asyncio.wait_for(asyncio.to_thread(llm_cmd._resolve_or_choose, project_id=""), timeout=CLI_TIMEOUT)
    except asyncio.TimeoutError:
        return CliResult.not_yet("no LLM source was chosen in time")
    except typer.Exit as exc:
        # `_fail` has already said why, to this process's stderr — the log.
        return CliResult.not_yet(f"no LLM source was settled (exit {exc.exit_code})")
    except Exception as exc:  # noqa: BLE001 — the setup that follows must still run
        _log.warning("llm setup: resolving an LLM source failed", exc_info=True)
        return CliResult.not_yet(f"resolving an LLM source failed: {exc}")
    return CliResult.satisfied(f"{row.name} ({row.kind}) funds {', '.join(row.active_for)}")


async def navigate_to_wizard(wizard: "Wizard") -> None:
    """Send whatever tab is open to this wizard's own page — the list of tools
    and their live status, not whatever screen the person happened to be on.

    Best-effort and silent either way: no live tab (headless, or nobody has
    opened the app yet) means nothing to send anywhere, same as `ask_window`'s
    own tolerance for the identical situation.
    """
    try:
        from flow_sdk.notifications.ui_command import send_ui_command  # noqa: PLC0415
        from flow_sdk.server.routes.websocket import get_active_connection  # noqa: PLC0415

        target = get_active_connection()
        if target is None:
            return
        _connection_id, socket = target
        await send_ui_command(
            socket,
            "navigate_dock",
            view_type="assets",
            pointer=f"editor/wizard/typeid/{wizard.typeid}",
        )
    except Exception:  # noqa: BLE001 — no socket, no server: nothing to steer
        _log.debug("llm setup: no live tab to show the wizard page on", exc_info=True)


async def show_wizard_fresh(wizard: "Wizard") -> None:
    """Clear the wizard's last run and send the active tab to its page — steps blank, nothing
    running. What `POST /wizard/<id>/open` does, and the first move of every setup run.

    A run already in progress keeps its record (`reset_run` refuses), so this never blanks a page
    that is showing live work.
    """
    from flow_sdk.core.wizard.execute import _notify_wizard_watchers  # noqa: PLC0415
    from flow_sdk.core.wizard.state import reset_run  # noqa: PLC0415

    if reset_run(str(wizard.id)) is not None:
        await _notify_wizard_watchers(str(wizard.id))
    await navigate_to_wizard(wizard)


#: The started run in flight for each wizard (by id) — the one a newer `start_wizard` replaces.
_STARTS: "dict[str, asyncio.Task]" = {}

#: What a replaced run's activity node and its caller are told.
START_REPLACED = "replaced by a newer start"


async def start_wizard(wizard: "Wizard", *, unattended: bool) -> "tuple[Optional[ReturnedValue], WizardResult]":
    """Start a wizard, stopping a start already in flight for it first.

    The newest start wins, for this wizard only: the first-run trigger and the popup's Start button
    both land here, and a person who clicks the button while the trigger's run is still going means
    "start over", not "already running". The old
    run is cancelled — its shell commands' process groups killed (`run_shell`), its
    agent closed (`_prompt_and_wait`), its open question withdrawn (`ask_person`) —
    and awaited until it has let go of the wizard's run lock, so `_start_wizard`'s
    `reset_run` always clears the old run's progress before the new one shows.

    A replaced caller answers ``busy`` with `START_REPLACED` rather than raising:
    the HTTP edge maps that to 409, and the trigger logs it.
    """
    from flow_sdk.schema.data_spec.returned_value_spec import CliResult, WizardResult  # noqa: PLC0415

    key = str(wizard.id)
    previous = _STARTS.get(key)
    run = asyncio.ensure_future(_start_wizard(wizard, unattended=unattended, previous=previous))
    _STARTS[key] = run
    try:
        return await run
    except asyncio.CancelledError:
        current = asyncio.current_task()
        if current is not None and current.cancelling():
            raise  # the caller itself is being cancelled — not a replacement
        return CliResult.not_yet(START_REPLACED, ran=False), WizardResult.held(
            f"{wizard.name or 'The wizard'} was {START_REPLACED}."
        )
    finally:
        if _STARTS.get(key) is run:
            del _STARTS[key]


async def _start_wizard(
    wizard: "Wizard", *, unattended: bool, previous: "Optional[asyncio.Task]"
) -> "tuple[Optional[ReturnedValue], WizardResult]":
    """Start a wizard: its LLM source first when its document says it needs one, then its steps.

    A wizard that declares ``requires_llm_source`` (first-run setup) has the source settled BEFORE
    it and outside it (`_resolve_llm_source`). Whatever that answers, the wizard runs next: only its
    agent fallbacks need a source, and every plain install command works without one. The two
    answers come back side by side, so a caller can say which of them fell short. A wizard that
    declares nothing has no source step: the first answer is ``None``.

    One function for both ways in — the trigger on the first tab after install,
    and the popup's Start button — so the order cannot drift between them. Both also
    steer the active tab to the wizard's own page before running it: neither
    caller is "the person is already looking at the wizard", so without this
    the whole run is invisible behind whatever screen was already open.

    Steered TWICE, not once. `_resolve_llm_source` itself navigates to the
    chooser (`/dock/llm-setup`) whenever the box is not already funded — a
    second navigation, landing well after the first, that overwrites it. A
    person who was just sent to the wizard page is then sent past it to the
    chooser, and once they press its own "Done" nothing sends them back: they
    are left on whatever the chooser's own close-target is (its caller's
    "home"), watching a wizard run they cannot see. So this steers again right
    before the wizard actually starts — a wasted no-op when the box was
    already funded and the chooser never opened, and the fix when it did.

    The previous run's answers are cleared FIRST, before the page is shown.
    `execute_wizard` clears them too, but only once the wizard itself starts —
    after the LLM source, which can mean minutes in the chooser — so the page
    opened onto the last run's leftovers and only emptied later. A run already
    in progress keeps its record (`reset_run` refuses); `wizard.run` then
    answers "already running", as it always did. A previous SETUP run is never
    that case: it is stopped first (see `start_wizard`), so only a run started
    some other way — the wizard page's own Run button — still refuses here.
    """
    if previous is not None and not previous.done():
        _log.info("wizard start: stopping the start already in flight")
        previous.cancel(START_REPLACED)
        # Until it has unwound: its `execute_wizard` releases the run lock on the
        # way out, and `reset_run` below refuses while that lock is held.
        await asyncio.wait({previous})
    await show_wizard_fresh(wizard)
    spec = wizard.spec()
    source = None
    if spec is not None and spec.requires_llm_source:
        source = await _resolve_llm_source()
        _log.info("llm setup: LLM source — %s", source.detail or ("ok" if source.ok else "not done"))
        await navigate_to_wizard(wizard)
    return source, await wizard.run(unattended=unattended)


def person_is_watching() -> bool:
    """Whether a live app tab is open right now — someone who can read a page and press its buttons.

    A trigger that fires a popup wizard uses it to choose: put the popup in front of them and wait
    for their Start, or (headless box, no tab ever) start it itself.
    """
    from flow_sdk.server.routes.websocket import get_active_connection  # noqa: PLC0415

    return get_active_connection() is not None
