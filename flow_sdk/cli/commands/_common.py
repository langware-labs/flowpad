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

It also owns the CLI's HTTP transport (``local_get`` / ``local_post``). That is
not an aesthetic grouping: a bare ``requests`` call to the local server is
refused outright on a gated instance, so every command that builds its own is a
command that breaks the moment the gate is armed. One seam, one place that
presents the secret.
"""

from __future__ import annotations

import json
import os
from typing import TYPE_CHECKING, Any, Callable, NoReturn, Optional

import typer

if TYPE_CHECKING:
    import requests

EXIT_INVALID_ARG = 2
EXIT_CONNECTION_ERROR = 5


def fail(exit_code: int, error_code: str, message: str, extra: "dict[str, Any] | None" = None) -> NoReturn:
    """Print a parseable error envelope to stderr and exit with the given code.

    ``extra`` merges structured fields into the envelope — a `remediation` list,
    the project that needs linking, a docs path. An agent should be able to act
    on a refusal without scraping the prose message for it.
    """
    typer.echo(f"Error: {message}", err=True)
    for step in (extra or {}).get("remediation") or []:
        typer.echo(f"  → {step}", err=True)
    typer.echo(json.dumps({"ok": False, "error_code": error_code, "error": message, **(extra or {})}), err=True)
    raise typer.Exit(exit_code)


def ok(payload: dict[str, Any]) -> None:
    typer.echo(json.dumps({"ok": True, **payload}))


def caller_abs_path(path: str) -> str:
    """Absolutize a caller-supplied path before it crosses the wire.

    The CLI runs in the agent's working directory; the server does not, and that
    cwd never crosses the wire. A relative path sent as typed therefore gets
    resolved against the SERVER's launch directory instead — for a packaged
    install, ``~/.local/bin`` — addressing a different, usually nonexistent
    file while the route still answers success.

    Every command that puts a ``path`` on the wire routes through here, so the
    fix cannot be applied to one command and missed by the next.
    """
    return os.path.abspath(os.path.expanduser(path.strip()))


def discover_port() -> int:
    """Resolve the active instance's running port (FLOW_INSTANCE-aware)."""
    from flow_sdk.discovery.flowpad_discovery import InstanceNotRunningError, resolve_cli_port

    try:
        return resolve_cli_port()
    except InstanceNotRunningError as e:
        fail(EXIT_CONNECTION_ERROR, "INSTANCE_NOT_RUNNING", str(e))


def local_request(method: str, url: str, **kwargs: Any) -> "requests.Response":
    """``requests.request`` with this instance's cookie-gate header attached.

    THE transport for every CLI call to the local server, and the reason this
    module owns one: ``CookieGateMiddleware`` refuses every request that cannot
    present the secret, with NO path and NO loopback exemption. A command that
    builds its own bare ``requests`` call therefore stops working the moment the
    instance is gated — which is what shipped, and what answered every ``flow``
    command inside a gated sandbox with the gate's 403 HTML page.

    ``gate_headers`` decides whether anything is attached; it yields nothing for
    an unarmed instance or a non-loopback URL, so this is safe to use for every
    outbound call a command makes.

    An explicit ``headers`` kwarg wins — the gate header is merged underneath it
    — so a caller can still override it deliberately.
    """
    import requests

    from flow_sdk.instance_settings.cookie_gate import gate_headers

    headers = {**gate_headers(url), **(kwargs.pop("headers", None) or {})}
    if headers:
        kwargs["headers"] = headers
    return requests.request(method, url, **kwargs)


def local_get(url: str, **kwargs: Any) -> "requests.Response":
    return local_request("GET", url, **kwargs)


def local_post(url: str, **kwargs: Any) -> "requests.Response":
    return local_request("POST", url, **kwargs)


def bad_response_message(resp: "requests.Response") -> str:
    """Describe a response that is not the JSON envelope, naming the gate.

    The gate answers with an HTML page, so a caller expecting JSON used to
    report ``Bad response: <!doctype html>…`` — the first 200 characters of a
    document written for a human, which says nothing an agent can act on. With
    ``local_request`` presenting the secret this should now be unreachable, so
    if it is reached the secret could not be read at all, and that is what the
    message says.
    """
    if resp.status_code == 403 and "html" in (resp.headers.get("content-type") or "").lower():
        return (
            "Request refused by this instance's cookie-gate (HTTP 403): the CLI "
            "could not read the gate secret. Check that the instance is logged in "
            "and its secret store is readable, or run "
            "`flow auth clear-cookie-gate` to disarm the gate."
        )
    return f"Bad response (status {resp.status_code}): {resp.text[:200]}"


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
        resp = local_post(url, json=payload or {}, timeout=timeout)
    except requests.exceptions.RequestException as e:
        fail(EXIT_CONNECTION_ERROR, "CONNECTION_ERROR", f"Cannot reach Flowpad server at {url}: {e}")
    try:
        body = resp.json()
    except ValueError:
        fail(EXIT_CONNECTION_ERROR, "CONNECTION_ERROR", bad_response_message(resp))

    if resp.status_code != 200 or body.get("status") != "SUCCESS":
        on_error(resp.status_code, body)
    return body.get("data") or {}


def current_process_typeid() -> "str | None":
    """The AgenticProcess this command is running inside, or ``None`` outside one.

    The non-fatal half of :func:`resolve_process_id`: a command that merely wants to
    ATTRIBUTE something to the calling process (progress, say) must not abort when there
    is no process — a plain shell on the box is a legitimate caller.
    """
    from flow_sdk.utils.environment import get_execution_scope

    try:
        for scope in get_execution_scope():
            if isinstance(scope, dict) and scope.get("type") == "agentic_process" and scope.get("id"):
                return f"agentic_process-{scope['id']}"
            if isinstance(scope, str) and scope.startswith("agentic_process-"):
                return scope
    except Exception:  # noqa: BLE001 — no scope is an answer, not a failure
        return None
    return None


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
