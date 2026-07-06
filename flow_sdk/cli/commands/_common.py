"""Shared plumbing for ``flow`` CLI command modules.

Every ``flow <group>`` command speaks the same parseable envelope (agents
parse these — keep the shapes stable):

* success → stdout ``{"ok": true, ...}``
* failure → stderr ``Error: <msg>`` + ``{"ok": false, "error_code": ..., "error": ...}``
  and a non-zero exit code.

Command modules import these as their private names
(``from ._common import fail as _fail, ...``) so call sites read the same
everywhere; group-specific EXIT_* codes stay in each module as part of its
documented contract.
"""

from __future__ import annotations

import json
from typing import Any, Callable, NoReturn, Optional

import typer

EXIT_INVALID_ARG = 2
EXIT_CONNECTION_ERROR = 5


def fail(exit_code: int, error_code: str, message: str) -> NoReturn:
    """Print a parseable error envelope to stderr and exit with the given code."""
    typer.echo(f"Error: {message}", err=True)
    typer.echo(json.dumps({"ok": False, "error_code": error_code, "error": message}), err=True)
    raise typer.Exit(exit_code)


def ok(payload: dict[str, Any]) -> None:
    typer.echo(json.dumps({"ok": True, **payload}))


def discover_port() -> int:
    """Resolve the active instance's running port (FLOW_INSTANCE-aware)."""
    from flow_sdk.discovery.flowpad_discovery import InstanceNotRunningError, resolve_cli_port

    try:
        return resolve_cli_port()
    except InstanceNotRunningError as e:
        fail(EXIT_CONNECTION_ERROR, "INSTANCE_NOT_RUNNING", str(e))


def post_graph_json(
    url: str,
    payload: Optional[dict],
    *,
    timeout: int = 15,
    on_error: "Callable[[int, dict], NoReturn]",
) -> dict:
    """POST JSON to a graph endpoint and return the SUCCESS envelope's ``data``.

    Owns the transport layer every graph-action command shares: request errors
    and non-JSON bodies fail as CONNECTION_ERROR; any other non-success response
    is delegated to ``on_error(status_code, body)`` — which must exit — so each
    command keeps its own documented exit-code contract without re-implementing
    the POST/parse/envelope boilerplate.
    """
    import requests

    try:
        resp = requests.post(url, json=payload or {}, timeout=timeout)
    except requests.exceptions.RequestException as e:
        fail(EXIT_CONNECTION_ERROR, "CONNECTION_ERROR", f"Cannot reach Flowpad server at {url}: {e}")
    try:
        body = resp.json()
    except ValueError:
        fail(EXIT_CONNECTION_ERROR, "CONNECTION_ERROR", f"Bad response: {resp.text[:200]}")

    if resp.status_code != 200 or body.get("status") != "SUCCESS":
        on_error(resp.status_code, body)
    return body.get("data") or {}


def resolve_process_id(process_opt: Optional[str]) -> str:
    """Target AgenticProcess id from ``--process`` (bare id or
    ``agentic_process-<id>`` TypeId), falling back to the current process
    advertised in ``FLOWPAD_EXECUTION_SCOPE``."""
    if process_opt:
        raw = process_opt.strip()
        return raw.split("agentic_process-", 1)[1] if raw.startswith("agentic_process-") else raw

    from flow_sdk.utils.environment import get_execution_scope

    for s in get_execution_scope():
        if isinstance(s, dict) and s.get("type") == "agentic_process" and s.get("id"):
            return str(s["id"])
        if isinstance(s, str) and s.startswith("agentic_process-"):
            return s.split("-", 1)[1]

    fail(
        EXIT_INVALID_ARG,
        "NO_PROCESS",
        "Pass --process or run inside an AgenticProcess (FLOWPAD_EXECUTION_SCOPE)",
    )
