"""Starting a wizard from the person's side: its page, its LLM source, its run.

What the wizard's `open` / `start` actions and its trigger callbacks share. A wizard's document
says what it needs (``requires_llm_source``); nothing here names a particular wizard.
"""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING, Optional

from flow_sdk.core.compute.llm_source import settle_llm_source

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.builtin.wizard import Wizard
    from flow_sdk.schema.data_spec.returned_value_spec import CliResult, ReturnedValue, WizardResult

_log = logging.getLogger(__name__)


async def _resolve_llm_source() -> "CliResult":
    """Settle the box's LLM source before the wizard's steps run — see `settle_llm_source`."""
    return await settle_llm_source()


async def navigate_to_wizard(wizard: "Wizard") -> None:
    """Put this wizard in front of whatever tab is open.

    A popup wizard opens as a dialog OVER the page the person is on, which stays exactly as it was
    (`open_wizard_popup`, the same shape as an ask's `open_ask_modal`). Any other wizard takes the
    tab to its own page — the list of tools and their live status.

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
        if wizard.popup:
            await send_ui_command(socket, "open_wizard_popup", pointer=str(wizard.typeid))
            return
        await send_ui_command(
            socket,
            "navigate_dock",
            view_type="assets",
            pointer=f"editor/wizard/typeid/{wizard.typeid}",
        )
    except Exception:  # noqa: BLE001 — no socket, no server: nothing to steer
        _log.debug("wizard start: no live tab to show the wizard on", exc_info=True)


async def show_wizard_fresh(wizard: "Wizard") -> None:
    """Clear the wizard's last run and show it on the active tab — steps blank, nothing
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
    result = await wizard.run(unattended=unattended)
    if spec is not None and spec.requires_llm_source:
        source = await _settle_after_install(source)
    return source, result


async def _settle_after_install(before: "Optional[CliResult]") -> "Optional[CliResult]":
    """Settle the LLM source again, now that the steps may have installed the default harness.

    The first settle ran before anything was installed, when an absent default could be funded by
    nothing, so it accepted any funded harness. Once the default is on the box, "set up" means IT
    is funded: the status refresh records the new CLI and probes its login, and the settle then
    opens the chooser if that login is signed out — the sign-in step, asked only when needed.
    """
    from flow_sdk.core.status import default_harness_kind, harness_install, refresh_status  # noqa: PLC0415
    from flow_sdk.flowpad_types.vendors import vendor_by  # noqa: PLC0415
    from flow_sdk.schema.data_spec.status_spec import InstallState  # noqa: PLC0415

    if before is not None and not before.ok:
        # The person skipped (or could not finish) the chooser: that is their answer, and they are
        # not asked twice. Re-opening it here navigated the tab away from the wizard they watch.
        return before
    try:
        kind = await default_harness_kind()
        await refresh_status([kind] if kind else None)
        vendor = vendor_by("capability_kind", kind) if kind else None
        installed = vendor is not None and harness_install(vendor.key) is InstallState.INSTALLED
    except Exception:  # noqa: BLE001 — a failed refresh leaves the record as it was
        _log.warning("llm setup: refreshing status after the install failed", exc_info=True)
        installed = False
    if not installed:
        # Nothing new to fund: the first settle already answered for a box without the default
        # (and a person who skipped it is not asked twice).
        return before
    after = await _resolve_llm_source()
    _log.info("llm setup: LLM source after install — %s", after.detail or ("ok" if after.ok else "not done"))
    return after
