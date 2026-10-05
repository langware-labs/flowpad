"""``flow conversation ...`` CLI subgroup.

A thin HTTP caller over the SAME local-server REST actions the UI's TS SDK
hits — no business logic lives here (mirrors ``flow record``). Commands:

    flow conversation list                       — list conversations
    flow conversation summary <id>               — one line per message
    flow conversation show <id> [--last N]       — full messages, oldest-first
    flow conversation message <msg-id>           — one message in full
    flow conversation send <id> <message>        — add a text message
    flow conversation attach <id> <target> <msg> — add a message + attachment

``attach`` auto-detects ``<target>``: a ``<type>-<uuid>`` TypeId becomes an
entity reference (validated to exist via the graph GET); anything else is a
file path (validated to exist on disk) and uploaded as a multipart file.

Every id argument takes the bare uuid OR the TypeId the UI hands out
(``conversation-<uuid>`` / ``conversation/<uuid>``, ``flow_message-<uuid>``).

Every command emits the standard parseable envelope (``ok``/``fail`` from
``_common``): success → ``{"ok": true, ...}`` on stdout, failure →
``{"ok": false, "error_code", "error"}`` on stderr + non-zero exit.
"""

from __future__ import annotations

import os
from typing import Optional

import requests
import typer
from typing_extensions import Annotated

from flow_sdk.cli.commands._common import (
    bad_response_message as _bad_response_message,
)
from flow_sdk.cli.commands._common import (
    discover_port as _discover_port,
)
from flow_sdk.cli.commands._common import (
    fail as _fail,
)
from flow_sdk.cli.commands._common import (
    graph_url as _graph_url,
)
from flow_sdk.cli.commands._common import (
    local_get as _local_get,
)
from flow_sdk.cli.commands._common import (
    local_post as _local_post,
)
from flow_sdk.cli.commands._common import (
    ok as _ok,
)

conversation_app = typer.Typer(
    name="conversation",
    help="List, read, summarize, and add messages to Flowpad conversations.",
    add_completion=False,
    no_args_is_help=True,
)


EXIT_OK = 0
EXIT_INVALID_ARG = 2
EXIT_NOT_FOUND = 4
EXIT_CONNECTION_ERROR = 5
EXIT_ACTION_FAILED = 7

_CONV_ID_HELP = "Conversation id: the bare uuid or its TypeId (conversation-<uuid> / conversation/<uuid>)."
_MSG_ID_HELP = "Message id: the bare uuid or its TypeId (flow_message-<uuid>)."


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
        resp = _local_post(url, json=payload or {}, timeout=timeout)
    except requests.exceptions.RequestException as e:
        _fail(EXIT_CONNECTION_ERROR, "CONNECTION_ERROR", f"Cannot reach Flowpad server at {url}: {e}")
        raise  # unreachable
    return _envelope(resp, not_found_hint=not_found_hint)


def _envelope(resp: "requests.Response", *, not_found_hint: Optional[str] = None) -> dict:
    """Parse a graph-API response, mapping it onto the CLI's stable exit codes."""
    try:
        body = resp.json()
    except ValueError:
        _fail(EXIT_CONNECTION_ERROR, "CONNECTION_ERROR", _bad_response_message(resp))
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


def _bare_id(value: str, expected_type: str, label: str) -> str:
    """The uuid out of ``value`` — a bare uuid, or a TypeId of ``expected_type``
    in either the wire form (``<type>-<uuid>``) or the URL form the UI pastes
    (``<type>/<uuid>``). A TypeId of another type is refused rather than read
    as the wrong entity."""
    raw = (value or "").strip()
    if not raw:
        _fail(EXIT_INVALID_ARG, "INVALID_ARG", f"{label} is required")
    tid = _entity_typeid_or_none(raw.replace("/", "-", 1))
    if tid is None:
        return raw
    if tid.type != expected_type:
        _fail(EXIT_INVALID_ARG, "INVALID_ARG", f"{label} must be a {expected_type}, got {tid.type}")
    return tid.id


def _conversation_id(value: str) -> str:
    return _bare_id(value, "conversation", "conversation_id")


def _message_id(value: str) -> str:
    return _bare_id(value, "flow_message", "message_id")


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
    url = _graph_url(_discover_port(), "conversation-list")
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
    help=(
        "Print a plain-text summary (header + one line per message, cut to 80 chars) of a "
        "conversation. Use `show` to read the messages in full."
    ),
)
def summary_conversation(
    conversation_id: Annotated[str, typer.Argument(help=_CONV_ID_HELP)],
) -> None:
    cid = _conversation_id(conversation_id)
    url = _graph_url(_discover_port(), "conversation-summary")
    data = _post_json(url, {"conversation_id": cid}, not_found_hint=f"Conversation not found: {cid}")
    _ok({"conversation_id": cid, "summary": data.get("summary") or ""})


def _render_message(m: dict) -> str:
    """One message as an agent reads it: a header line, the full text, then
    one line per attachment saying where its bytes are — or that they are not
    on this machine yet."""
    status = m.get("delivery_status") or ""
    if m.get("from") == "them":
        status = "read" if m.get("is_read") else "unread"
    head = f"── {m.get('ts') or '?'} · {m.get('sender')} ({m.get('from')}) · {status} · msg {m.get('id')}"
    if m.get("reply_to_id"):
        head += f" · reply to {m['reply_to_id']}"
    lines = [head]
    text = (m.get("text") or "").rstrip()
    lines.append(text if text else "(no text)")
    for a in m.get("attachments") or []:
        where = a.get("local_path") or ("(not on this machine — body not downloaded)" if not a.get("available") else "")
        desc = f"  📎 {a.get('type')}: {a.get('data')}"
        if a.get("prompt_preview"):
            desc += f" — {' '.join(a['prompt_preview'].split())[:200]}"
        lines.append(f"{desc}  {where}".rstrip())
    return "\n".join(lines)


def _render_transcript(data: dict) -> str:
    people = ", ".join(data.get("participants") or [])
    shown, total = len(data.get("messages") or []), data.get("message_count")
    lines = [
        f"Conversation: {data.get('title') or '(untitled)'}  [conversation-{data.get('id')}]",
        f"Participants: {people or '(none)'}",
        f"Messages: showing {shown} of {total}, oldest first",
        "",
    ]
    lines.extend(_render_message(m) + "\n" for m in data.get("messages") or [])
    return "\n".join(lines).rstrip() + "\n"


@conversation_app.command(
    "show",
    help=(
        "Read a conversation in full: every message's timestamp, sender (you/them), "
        "id, complete text and attachments with their local paths. Oldest first."
    ),
)
def show_conversation(
    conversation_id: Annotated[str, typer.Argument(help=_CONV_ID_HELP)],
    last: Annotated[Optional[int], typer.Option("--last", help="Only the newest N messages.")] = None,
    since: Annotated[
        Optional[str], typer.Option("--since", help="Only messages at/after this ISO timestamp.")
    ] = None,
    as_json: Annotated[bool, typer.Option("--json", help="Emit the structured envelope instead of text.")] = False,
) -> None:
    cid = _conversation_id(conversation_id)
    if last is not None and last < 0:
        _fail(EXIT_INVALID_ARG, "INVALID_ARG", "--last must be >= 0")
    payload: dict = {"conversation_id": cid}
    if last is not None:
        payload["last"] = last
    if since:
        payload["since"] = since
    url = _graph_url(_discover_port(), "conversation-transcript")
    data = _post_json(url, payload, not_found_hint=f"Conversation not found: {cid}")
    if as_json:
        _ok({"conversation_id": cid, **data})
    else:
        typer.echo(_render_transcript(data), nl=False)


@conversation_app.command(
    "message",
    help=(
        "Read one message in full: its text, attachments, and the files of its "
        "downloaded body (or a plain note that the body is not on this machine)."
    ),
)
def show_message(
    message_id: Annotated[str, typer.Argument(help=_MSG_ID_HELP)],
    as_json: Annotated[bool, typer.Option("--json", help="Emit the structured envelope instead of text.")] = False,
) -> None:
    mid = _message_id(message_id)
    url = _graph_url(_discover_port(), "conversation-message-read")
    data = _post_json(url, {"message_id": mid}, not_found_hint=f"Message not found: {mid}")
    if as_json:
        _ok({"message_id": mid, **data})
        return
    lines = [f"Conversation: conversation-{data.get('conversation_id')}", _render_message(data)]
    if data.get("unpacked_dir"):
        lines.append(f"\nBody: {data['unpacked_dir']}")
        lines.extend(f"  {f}" for f in data.get("unpacked_files") or [])
    elif data.get("attachments") and not data.get("body_downloaded"):
        lines.append("\nBody: not downloaded to this machine yet (sign in / let it sync); do not guess its content.")
    typer.echo("\n".join(lines))


def _add_message_url(port: int, conversation_id: str) -> str:
    return _graph_url(port, f"conversation/{conversation_id}/add_message")


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
    conversation_id: Annotated[str, typer.Argument(help=_CONV_ID_HELP)],
    message: Annotated[str, typer.Argument(help="Message text to send.")],
) -> None:
    cid = _conversation_id(conversation_id)
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
    from flow_sdk.fs_store.type_id import TypeId  # noqa: PLC0415

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
    conversation_id: Annotated[str, typer.Argument(help=_CONV_ID_HELP)],
    target: Annotated[
        str,
        typer.Argument(help="A '<type>-<uuid>' entity TypeId OR a path to a file."),
    ],
    message: Annotated[str, typer.Argument(help="Message text to send with the attachment.")],
    session: Annotated[
        Optional[str],
        typer.Option(
            "--session",
            help=(
                "Live-session id (remote_worker_session). Stamps the message "
                "into that session's exchange — it groups into the live-session "
                "view and the receiver eager-pulls the body bundle, so attached "
                "files are clickable on arrival."
            ),
        ),
    ] = None,
) -> None:
    cid = _conversation_id(conversation_id)
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
        probe_url = _graph_url(port, f"{tid.type}/{tid.id}")
        try:
            probe = _local_get(probe_url, timeout=15)
        except requests.exceptions.RequestException as e:
            _fail(EXIT_CONNECTION_ERROR, "CONNECTION_ERROR", f"Cannot reach Flowpad server at {probe_url}: {e}")
            return
        if probe.status_code == 404:
            _fail(EXIT_NOT_FOUND, "NOT_FOUND", f"Entity not found: {tgt}")
        if probe.status_code != 200:
            _fail(EXIT_ACTION_FAILED, "ACTION_FAILED", f"Could not resolve entity {tgt}: HTTP {probe.status_code}")
        entity_body = {"text": message, "asset_references": [tgt]}
        if session:
            entity_body["remote_worker_session_id"] = session.strip()
        data = _post_json(
            url,
            entity_body,
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
    form_fields = {"text": message}
    if session:
        form_fields["remote_worker_session_id"] = session.strip()
    try:
        resp = _local_post(
            url,
            data=form_fields,
            files={"files": (filename, content)},
            timeout=60,
        )
    except requests.exceptions.RequestException as e:
        _fail(EXIT_CONNECTION_ERROR, "CONNECTION_ERROR", f"Cannot reach Flowpad server at {url}: {e}")
        return
    data = _envelope(resp, not_found_hint=f"Conversation not found: {cid}")
    _emit_send_result(cid, data)


@conversation_app.command(
    "reply",
    help="Say something to the person in a conversation, on the channel they use (WhatsApp, email, voice …).",
)
def reply_on_channel(
    conversation_id: Annotated[str, typer.Argument(help=_CONV_ID_HELP)],
    text: Annotated[str, typer.Argument(help="What to say (may be empty when sending files).")] = "",
    reply_to: Annotated[
        Optional[str],
        typer.Option("--reply-to", help="Message id to quote (on email/Slack: to answer in its thread)."),
    ] = None,
    file: Annotated[
        Optional[list[str]],
        typer.Option("--file", help="A file to send; repeat for several. The channel refuses what it cannot take."),
    ] = None,
) -> None:
    from flow_sdk.cli.commands._common import local_request  # noqa: PLC0415

    cid = _conversation_id(conversation_id)
    paths = [os.path.abspath(os.path.expanduser(p)) for p in (file or [])]
    if not ((text or "").strip() or paths):
        _fail(EXIT_INVALID_ARG, "INVALID_ARG", "text (or --file) is required")
    missing = [p for p in paths if not os.path.isfile(p)]
    if missing:
        _fail(EXIT_INVALID_ARG, "INVALID_ARG", f"no such file: {missing[0]}")
    payload = {"text": text, "files": paths, **({"reply_to_id": reply_to.strip()} if reply_to else {})}
    url = f"http://127.0.0.1:{_discover_port()}/api/v1/conversations/{cid}/reply"
    body = local_request("POST", url, json=payload, timeout=30).json()
    if body.get("status") != "SUCCESS":
        _fail(7, "REFUSED", str(body.get("message") or body))
    _ok({"conversation_id": cid, **(body.get("data") or {})})


@conversation_app.command(
    "react",
    help="Put an emoji on a channel message (WhatsApp, Telegram, Slack …); --remove takes it back.",
)
def react_to_message(
    message_id: Annotated[str, typer.Argument(help=_MSG_ID_HELP)],
    emoji: Annotated[str, typer.Argument(help="The emoji, e.g. 👍 (empty with --remove: all of ours).")] = "",
    remove: Annotated[bool, typer.Option("--remove", help="Take the reaction back.")] = False,
) -> None:
    from flow_sdk.cli.commands._common import local_request  # noqa: PLC0415

    mid = _message_id(message_id)
    if not (emoji.strip() or remove):
        _fail(EXIT_INVALID_ARG, "INVALID_ARG", "an emoji is required")
    url = _graph_url(_discover_port(), f"flow_message/{mid}/react")
    body = local_request("POST", url, json={"emoji": emoji.strip(), "remove": remove}, timeout=30).json()
    if body.get("status") != "SUCCESS":
        _fail(7, "REFUSED", str(body.get("message") or body))
    _ok({"message_id": mid, **(body.get("data") or {})})
