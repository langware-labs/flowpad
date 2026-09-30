"""Settling the box's LLM source, for whoever is about to need one.

Two callers, one rule: first-run setup before its steps (`core/wizard/start.py`), and an agent
step that finds nothing able to fund it (`core/compute/process_step.py`). Both ask the same
question — is there a verified source, and if not, does the person want to pick one — and get the
same chooser; neither names a particular wizard.
"""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.schema.data_spec.returned_value_spec import CliResult

_log = logging.getLogger(__name__)


def person_is_watching() -> bool:
    """Whether a live app tab is open right now — someone who can read a page and press its buttons.

    A trigger that fires a popup wizard uses it to choose: put the popup in front of them and wait
    for their Start, or (headless box, no tab ever) start it itself. An agent step uses it to decide
    whether asking for an LLM source can be answered at all.
    """
    from flow_sdk.server.routes.websocket import get_active_connection  # noqa: PLC0415

    return get_active_connection() is not None


async def settle_llm_source(*, only_if_watched: bool = False) -> "CliResult":
    """`flow llm set auto`, run IN this process. Idempotent: it returns at once
    when the box is already funded, without opening anything.

    ``only_if_watched`` answers "not settled" straight away when no app tab is open, instead of
    opening a browser nobody is looking at and waiting on it: for a caller that asks in the middle
    of a run (an agent step), where a headless box has nobody to answer.

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
    from flow_sdk.schema.data_spec.returned_value_spec import CliResult  # noqa: PLC0415

    if only_if_watched and not person_is_watching():
        return CliResult.not_yet("no LLM source is set up, and nobody is watching to choose one")

    import typer  # noqa: PLC0415

    from flow_sdk.cli.commands import llm_cmd  # noqa: PLC0415
    from flow_sdk.schema.data_spec.compute_op_spec import CLI_TIMEOUT  # noqa: PLC0415

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
