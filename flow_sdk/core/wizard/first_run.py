"""First-run setup comes before any project setup.

The first-run wizard (``llm-setup``) installs what every project's setup stands on — an LLM source,
Claude Code, Python, Git, Node.js. So a project's setup does not start until that wizard's last run
ended with every step green; :func:`require_first_run` is the gate, called from ``start_setup``, the
one door every setup run goes through (a screen, ``flow``, an agent, a web app found owing setup).

Starting what is ALREADY set up (a load's ``load`` phase) is not setup and is never held.
"""

from __future__ import annotations

import logging
import os

logger = logging.getLogger(__name__)

#: What a refusal is tagged with, on the wire and in a ``LoadResult``.
FIRST_RUN_BLOCK = "first_run_setup"


class FirstRunPending(RuntimeError):
    """Project setup asked for before the first-run wizard ended all green."""

    code = FIRST_RUN_BLOCK

    def __init__(self) -> None:
        super().__init__("Finish setting up Flowpad first: project setup starts once every step of it is done.")


async def first_run_done() -> bool:
    """Whether project setup may start: the first-run wizard's last run ended with every step green.

    Open on a test backend (``FLOWPAD_SKIP_FIRST_RUN_SETUP``, which never runs the wizard), on a box
    the hub launched (its template carries every tool; the wizard runs there unattended, unseen), and
    on an install that does not ship the wizard or has it disabled — there is nothing to finish.
    """
    from flow_sdk.builtin.wizard import Wizard  # noqa: PLC0415
    from flow_sdk.core.wizard.state import read_result  # noqa: PLC0415
    from flow_sdk.instance_settings.runtime import get_assigned_runtime  # noqa: PLC0415
    from flow_sdk.server.builtin_triggers import LLM_SETUP_WIZARD, SKIP_FIRST_RUN_SETUP_ENV  # noqa: PLC0415

    if os.environ.get(SKIP_FIRST_RUN_SETUP_ENV, "").lower() == "true" or get_assigned_runtime() is not None:
        return True
    wizard = await Wizard.by_name(LLM_SETUP_WIZARD)
    spec = wizard.spec() if wizard is not None else None
    if spec is None or not (spec.enabled and wizard.enabled):
        return True
    result = read_result(str(wizard.id))
    return result is not None and result.ok


async def require_first_run() -> None:
    """Raise :class:`FirstRunPending` unless :func:`first_run_done`."""
    if not await first_run_done():
        logger.info("project setup held: the first-run wizard has not ended all green")
        raise FirstRunPending()
