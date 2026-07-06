"""`flow wizard ...` CLI subgroup — complete interactive wizard processes.

Agents running inside a wizard close it by emitting a typed result:

    flow wizard <agentic_process_id> close '{"status":"done","data":{}}'

The command posts to the generic entity-event action. The AgenticProcess
handler re-emits ``wizard.closed`` to resolve the frontend ``launchWizard``
promise.
"""

from __future__ import annotations

import json
from typing import Optional

import typer
from typing_extensions import Annotated

from flow_sdk.cli.commands._common import (
    EXIT_CONNECTION_ERROR,
    EXIT_INVALID_ARG,
    discover_port as _discover_port,
    fail as _fail,
    ok as _ok,
    post_graph_json as _post_graph_json,
)

EXIT_ACTION_FAILED = 7


def _process_id(raw: str) -> str:
    value = raw.strip()
    return value.split("agentic_process-", 1)[1] if value.startswith("agentic_process-") else value


def _close_from_args(wizard_id: Optional[str], args: list[str]) -> None:
    if not wizard_id or len(args) < 2 or args[0] != "close":
        _fail(
            EXIT_INVALID_ARG,
            "INVALID_WIZARD_COMMAND",
            "Usage: flow wizard <agentic_process_id> close '<json-result>'",
        )

    try:
        result = json.loads(args[1])
    except ValueError as e:
        _fail(EXIT_INVALID_ARG, "INVALID_JSON", f"Wizard result must be JSON: {e}")
    if not isinstance(result, dict):
        _fail(EXIT_INVALID_ARG, "INVALID_JSON", "Wizard result must be a JSON object")

    status = result.get("status")
    if status not in {"done", "cancel", "error"}:
        _fail(EXIT_INVALID_ARG, "INVALID_STATUS", "Wizard result status must be done, cancel, or error")

    process_id = _process_id(wizard_id)
    payload = {**result, "wizardId": result.get("wizardId") or process_id}
    port = _discover_port()
    url = f"http://127.0.0.1:{port}/api/v1/graph/agentic_process/{process_id}/entity-event"

    def _on_error(status_code: int, body: dict):
        _fail(
            EXIT_ACTION_FAILED if status_code != 0 else EXIT_CONNECTION_ERROR,
            str(body.get("error_code") or "ACTION_FAILED"),
            str(body.get("message") or body.get("error") or f"HTTP {status_code}"),
        )

    data = _post_graph_json(
        url,
        {"event": "wizard.close", "payload": payload},
        timeout=15,
        on_error=_on_error,
    )
    _ok({"process_id": process_id, "result": data.get("result") or data})


def wizard_command(
    ctx: typer.Context,
    wizard_id: Annotated[
        Optional[str],
        typer.Argument(help="Wizard AgenticProcess id or TypeId."),
    ] = None,
) -> None:
    """Complete a wizard using ``flow wizard <agentic_process_id> close <json>``."""
    _close_from_args(wizard_id, list(ctx.args))
