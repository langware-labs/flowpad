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
from typing import TYPE_CHECKING, Any, AsyncIterator, Awaitable, Callable, Literal, NoReturn, Optional, overload

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


@overload
def discover_port(required: Literal[True] = ...) -> int: ...


@overload
def discover_port(required: Literal[False]) -> "int | None": ...


def discover_port(required: bool = True) -> "int | None":
    """Resolve the active instance's running port (FLOW_INSTANCE-aware).

    ``required=False`` answers ``None`` instead of exiting, for a command that has something
    useful to do without a server — ``flow llm`` resolves in-process on a pure-CLI box. One
    probe either way, so "is an instance running" is asked the same way everywhere.
    """
    from flow_sdk.discovery.flowpad_discovery import InstanceNotRunningError, resolve_cli_port

    try:
        return resolve_cli_port()
    except InstanceNotRunningError as e:
        if not required:
            return None
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


def graph_url(port: int, path: str) -> str:
    """The local graph endpoint for ``path`` (``"project"``, ``"skill/<id>/show"``, …)."""
    return f"http://127.0.0.1:{port}/api/v1/graph/{path}"


def _graph_json(
    method: str, url: str, *, timeout: int, on_error: "Callable[[int, dict], NoReturn]", **kwargs: Any
) -> Any:
    import requests

    try:
        resp = local_request(method, url, timeout=timeout, **kwargs)
    except requests.exceptions.RequestException as e:
        fail(EXIT_CONNECTION_ERROR, "CONNECTION_ERROR", f"Cannot reach Flowpad server at {url}: {e}")
    try:
        body = resp.json()
    except ValueError:
        fail(EXIT_CONNECTION_ERROR, "CONNECTION_ERROR", bad_response_message(resp))

    if resp.status_code != 200 or body.get("status") != "SUCCESS":
        on_error(resp.status_code, body)
    return body.get("data")


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
    return _graph_json("POST", url, json=payload or {}, timeout=timeout, on_error=on_error) or {}


def get_graph_json(
    url: str,
    *,
    params: Optional[dict] = None,
    timeout: int = 15,
    on_error: "Callable[[int, dict], NoReturn]",
) -> Any:
    """GET a graph endpoint and return the SUCCESS envelope's ``data`` — the
    read twin of ``post_graph_json``, same transport and error contract."""
    return _graph_json("GET", url, params=params or {}, timeout=timeout, on_error=on_error)


def server_error(status_code: int, body: dict) -> NoReturn:
    """The default ``on_error``: any non-success answer is the server's fault."""
    fail(EXIT_CONNECTION_ERROR, "SERVER_ERROR", str(body.get("message") or f"HTTP {status_code}"))


def project_for_path(port: int, cwd: str, *, create: bool) -> "str | None":
    """The id of the project whose folder is ``cwd``, or ``None``.

    The natural key is the canonical mount path and it is QUERIED — the list
    route pushes the ``filter`` down as an indexed EQ — never scanned client
    side. ``create`` mints the project for a folder that has none, so a second
    run lands in the same project rather than a twin (``Project.find_by_cwd``'s
    own upsert rule: find, else save-new).
    """
    from flow_sdk.fs_store.path_utils import canonical_posix_path, is_valid_project_cwd

    if not is_valid_project_cwd(cwd, include_temp=True):
        fail(EXIT_INVALID_ARG, "INVALID_CWD", f"{cwd} cannot be a project folder; pass --project or cd into one")
    canonical = canonical_posix_path(cwd)
    rows = get_graph_json(
        graph_url(port, "project"),
        params={"filter": json.dumps({"fs_storage_mount_path": canonical})},
        on_error=server_error,
    )
    for row in rows if isinstance(rows, list) else []:
        if row.get("id"):
            return str(row["id"])
    if not create:
        return None
    created = post_graph_json(
        graph_url(port, "project"),
        {
            "type": "project",
            "name": os.path.basename(canonical.rstrip("/")) or canonical,
            "fs_storage_mount_path": canonical,
        },
        on_error=server_error,
    )
    return str(created["id"]) if created.get("id") else None


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


async def backend_frames(
    port: int,
    kinds: "frozenset[str] | set[str]",
    *,
    on_connected: "Callable[[], Awaitable[None]] | None" = None,
) -> "AsyncIterator[dict]":
    """Yield each WebSocket frame the local backend broadcasts whose ``message_type`` is in
    *kinds*. Blocks until the socket closes.

    The CLI's answer to "do something in the UI, and tell me when it lands". Every other command
    here is request/response, which cannot express that: the thing being waited for is a person,
    and the obvious spelling — poll on an interval with a timeout — is both banned by CLAUDE.md
    and wrong on the merits, because no number is the right one for a human. The backend already
    broadcasts on every state change worth waking for, so a caller blocks on the socket instead
    and needs no budget at all.

    *on_connected* fires AFTER the socket is established and before the first frame is read.
    That ordering is the whole reason it is a callback rather than something the caller does
    around this function: a caller that opens a browser first can be beaten by a user who acts
    instantly, and the frame that mattered is gone before anyone is listening. ``_login_by_window``
    resets its waiter for the same race.

    A frame is a WAKE-UP, not an answer. "A credential changed" and "the box can now do X" are
    different claims — a FAILED login broadcasts too — so callers re-ask whatever authority owns
    the second question rather than reading the frame's payload as a verdict.

    Carries the cookie-gate secret: the gate refuses WebSocket handshakes like everything else
    ("no path is exempt"), and a CLI is a machine caller, so it uses the header transport rather
    than the browser's query one.
    """
    import json as _json
    from uuid import uuid4

    import websockets

    from flow_sdk.instance_settings.cookie_gate import gate_headers

    # A fresh connection id per call: the backend keys its connection registry on it, and a
    # reused id would evict whatever else is listening under that name.
    url = f"ws://127.0.0.1:{port}/api/v1/connect/ws/flow-cli-{uuid4().hex[:8]}"
    headers = gate_headers(f"http://127.0.0.1:{port}/")

    async with websockets.connect(url, additional_headers=headers or None) as socket:
        if on_connected is not None:
            await on_connected()
        async for raw in socket:
            try:
                frame = _json.loads(raw)
            except (ValueError, TypeError):
                # The socket also carries msgpack binary frames (PTY streams). Not ours.
                continue
            if isinstance(frame, dict) and frame.get("message_type") in kinds:
                yield frame
