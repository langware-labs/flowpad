"""``flow conversation ...`` CLI subgroup.

A thin HTTP caller over the SAME local-server REST actions the UI's TS SDK
hits — no business logic lives here (mirrors ``flow record``). Four commands:

    flow conversation list                       — list conversations
    flow conversation summary <id>               — plain-text summary
    flow conversation send <id> <message>        — add a text message
    flow conversation attach <id> <target> <msg> — add a message + attachment

``attach`` auto-detects ``<target>``: a ``<type>-<uuid>`` TypeId becomes an
entity reference (validated to exist via the graph GET); anything else is a
file path (validated to exist on disk) and uploaded as a multipart file.

Every command emits the standard parseable envelope (``ok``/``fail`` from
``_common``): success → ``{"ok": true, ...}`` on stdout, failure →
``{"ok": false, "error_code", "error"}`` on stderr + non-zero exit.
"""

from __future__ import annotations

import os
from typing import Any, Optional

import requests
import typer
from typing_extensions import Annotated

from flow_sdk.cli.commands._common import (
    discover_port as _discover_port,
    fail as _fail,
    ok as _ok,
)

conversation_app = typer.Typer(
    name="conversation",
    help="List, summarize, and add messages to Flowpad conversations.",
    add_completion=False,
    no_args_is_help=True,
)


EXIT_OK = 0
EXIT_INVALID_ARG = 2
EXIT_NOT_FOUND = 4
EXIT_CONNECTION_ERROR = 5
EXIT_ACTION_FAILED = 7


def _post_json(
    url: str,
    payload: Optional[dict],
    *,
    timeout: int = 30,
    not_found_hint: Optional[str] = None,
) -> dict:
    """POST JSON to a graph endpoint and return its ``data`` envelope.

    Transport / parse / non-SUCCESS responses route through ``_fail`` (which
    exits). A 404 maps to ``EXIT_NOT_FOUND`` with ``not_found_hint`` when given.
    """
    try:
        resp = requests.post(url, json=payload or {}, timeout=timeout)
    except requests.exceptions.RequestException as e:
        _fail(EXIT_CONNECTION_ERROR, "CONNECTION_ERROR", f"Cannot reach Flowpad server at {url}: {e}")
        raise  # unreachable
    return _envelope(resp, not_found_hint=not_found_hint)


def _envelope(resp: "requests.Response", *, not_found_hint: Optional[str] = None) -> dict:
    """Parse a graph-API response, mapping it onto the CLI's stable exit codes."""
    try:
        body = resp.json()
    except ValueError:
        _fail(EXIT_CONNECTION_ERROR, "CONNECTION_ERROR", f"Bad response: {resp.text[:200]}")
        raise  # unreachable
    if resp.status_code == 404 and not_found_hint is not None:
        _fail(EXIT_NOT_FOUND, "NOT_FOUND", not_found_hint)
    if resp.status_code != 200 or body.get("status") != "SUCCESS":
        _fail(
            EXIT_ACTION_FAILED,
            str(body.get("error_code") or "ACTION_FAILED"),
            str(body.get("message") or body.get("error") or f"HTTP {resp.status_code}"),
        )
    return body.get("data") or {}


def _conv_summary_row(conv: dict) -> dict:
    """Trim a full conversation dump down to the fields ``list`` reports."""
    parts = [
        {
            "name": p.get("name"),
            "email": p.get("email"),
            "user_id": p.get("user_id"),
            "role": p.get("role"),
        }
        for p in (conv.get("members") or [])
    ]
    return {
        "id": conv.get("id"),
        "title": conv.get("title"),
        "kind": conv.get("kind"),
        "message_count": conv.get("message_count"),
        "participants": parts,
        "created_at": conv.get("created_at"),
        "updated_at": conv.get("modified_at") or conv.get("updated_at"),
    }


@conversation_app.command(
    "list",
    help="List the current user's conversations (title, participants, message count).",
)
def list_conversations() -> None:
    port = _discover_port()
    url = f"http://127.0.0.1:{port}/api/v1/graph/conversation-list"
    data = _post_json(url, {})
    convs = [_conv_summary_row(c) for c in (data.get("conversations") or [])]
    _ok(
        {
            "total": len(convs),
            "conversations": convs,
            # Surfaced so a one-shot CLI run can tell a degraded (offline / not
            # logged-in) snapshot apart from a fully-synced one.
            "hub_reachable": data.get("hub_reachable"),
            "auth_required": data.get("auth_required"),
        }
    )


@conversation_app.command(
    "summary",
    help="Print a plain-text summary (header + one line per message) of a conversation.",
)
def summary_conversation(
    conversation_id: Annotated[
        str, typer.Argument(help="Conversation id (the bare uuid, not a TypeId).")
    ],
) -> None:
    cid = (conversation_id or "").strip()
    if not cid:
        _fail(EXIT_INVALID_ARG, "INVALID_ARG", "conversation_id is required")
    port = _discover_port()
    url = f"http://127.0.0.1:{port}/api/v1/graph/conversation-summary"
    data = _post_json(
        url, {"conversation_id": cid}, not_found_hint=f"Conversation not found: {cid}"
    )
    _ok({"conversation_id": cid, "summary": data.get("summary") or ""})


def _add_message_url(port: int, conversation_id: str) -> str:
    return f"http://127.0.0.1:{port}/api/v1/graph/conversation/{conversation_id}/add_message"


def _emit_send_result(conversation_id: str, data: dict) -> None:
    delivery_status = data.get("delivery_status")
    _ok(
        {
            "conversation_id": conversation_id,
            "flow_message_id": data.get("flow_message_id") or data.get("id"),
            "message_count": data.get("message_count"),
            "delivery_status": delivery_status,
            # Composed offline / not logged in → saved locally, NOT delivered.
            "pending": delivery_status == "pending_send",
            "attachment": data.get("attachment") or [],
        }
    )


@conversation_app.command(
    "send",
    help="Add a text message to a conversation.",
)
def send_message(
    conversation_id: Annotated[str, typer.Argument(help="Conversation id (bare uuid).")],
    message: Annotated[str, typer.Argument(help="Message text to send.")],
) -> None:
    cid = (conversation_id or "").strip()
    if not cid:
        _fail(EXIT_INVALID_ARG, "INVALID_ARG", "conversation_id is required")
    if not (message or "").strip():
        _fail(EXIT_INVALID_ARG, "INVALID_ARG", "message is required")
    port = _discover_port()
    data = _post_json(
        _add_message_url(port, cid),
        {"text": message},
        not_found_hint=f"Conversation not found: {cid}",
    )
    _emit_send_result(cid, data)


def _entity_typeid_or_none(target: str):
    """Return the parsed ``TypeId`` if ``target`` is a ``<type>-<uuid>`` entity
    reference (UUID id specifically), else ``None``.

    Restricting the id to a real UUID keeps filenames that merely contain a
    dash (``FLOWPAD-1431.md``, ``my-notes.txt``) out of the entity branch — a
    file path is the fallback for anything that isn't a clean TypeId.
    """
    from flow_sdk.api.api_types.identifier import is_valid_uuid  # noqa: PLC0415
    from flow_sdk.api.type_id import TypeId  # noqa: PLC0415

    try:
        tid = TypeId(target)
    except Exception:  # noqa: BLE001
        return None
    return tid if (tid.type and tid.id and is_valid_uuid(tid.id)) else None


@conversation_app.command(
    "attach",
    help=(
        "Add a message with an attachment. <target> is auto-detected: a "
        "'<type>-<uuid>' TypeId attaches that entity (must exist); anything "
        "else is treated as a file path (must exist) and uploaded."
    ),
)
def attach_message(
    conversation_id: Annotated[str, typer.Argument(help="Conversation id (bare uuid).")],
    target: Annotated[
        str,
        typer.Argument(help="A '<type>-<uuid>' entity TypeId OR a path to a file."),
    ],
    message: Annotated[str, typer.Argument(help="Message text to send with the attachment.")],
) -> None:
    cid = (conversation_id or "").strip()
    if not cid:
        _fail(EXIT_INVALID_ARG, "INVALID_ARG", "conversation_id is required")
    tgt = (target or "").strip()
    if not tgt:
        _fail(EXIT_INVALID_ARG, "INVALID_ARG", "target (entity TypeId or file path) is required")
    if not (message or "").strip():
        _fail(EXIT_INVALID_ARG, "INVALID_ARG", "message is required")

    port = _discover_port()
    url = _add_message_url(port, cid)

    tid = _entity_typeid_or_none(tgt)
    if tid is not None:
        # Entity reference — validate it exists before referencing it.
        probe_url = f"http://127.0.0.1:{port}/api/v1/graph/{tid.type}/{tid.id}"
        try:
            probe = requests.get(probe_url, timeout=15)
        except requests.exceptions.RequestException as e:
            _fail(EXIT_CONNECTION_ERROR, "CONNECTION_ERROR", f"Cannot reach Flowpad server at {probe_url}: {e}")
            return
        if probe.status_code == 404:
            _fail(EXIT_NOT_FOUND, "NOT_FOUND", f"Entity not found: {tgt}")
        if probe.status_code != 200:
            _fail(EXIT_ACTION_FAILED, "ACTION_FAILED", f"Could not resolve entity {tgt}: HTTP {probe.status_code}")
        data = _post_json(
            url,
            {"text": message, "asset_references": [tgt]},
            not_found_hint=f"Conversation not found: {cid}",
        )
        _emit_send_result(cid, data)
        return

    # File path — validate on disk, then multipart-upload under the "files" field.
    path = os.path.expanduser(tgt)
    if not os.path.isfile(path):
        _fail(
            EXIT_INVALID_ARG,
            "INVALID_ARG",
            f"Not a TypeId and not an existing file: {tgt}",
        )
    filename = os.path.basename(path)
    try:
        with open(path, "rb") as fh:
            content = fh.read()
    except OSError as e:
        _fail(EXIT_INVALID_ARG, "INVALID_ARG", f"Cannot read file {tgt}: {e}")
        return
    try:
        resp = requests.post(
            url,
            data={"text": message},
            files={"files": (filename, content)},
            timeout=60,
        )
    except requests.exceptions.RequestException as e:
        _fail(EXIT_CONNECTION_ERROR, "CONNECTION_ERROR", f"Cannot reach Flowpad server at {url}: {e}")
        return
    data = _envelope(resp, not_found_hint=f"Conversation not found: {cid}")
    _emit_send_result(cid, data)
