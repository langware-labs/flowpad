"""Asking for help — ONE action for both channels (docs/collab/ask-for-help.md).

``ask-for-help`` asks a person (a task assigned to them, discussed in a conversation) or a desk (a
ticket in its queue). It writes the request HERE first and answers once it is written — the hub is
reached afterwards, by ``Conversation.deliver``, whose stage 0 (``open_on_hub``, below) creates the
conversation there. So signing in, the network and the hub decide when a request arrives, never
whether it exists; and the same ``conversation_id`` is the same request, however often it is sent.

POST /api/v1/graph/ask-for-help        — capture, then one delivery attempt
POST /api/v1/graph/help-recipients     — the desks this person can ask, nearest first
POST /api/v1/graph/help-requests       — my requests, both kinds, one row shape
POST /api/v1/graph/conversation/<id>/resend — the person's Retry: deliver it again, refusals included
POST /api/v1/graph/conversation/<id>/help-request-report — Report it: a private request becomes a desk ticket

The diagnosis never holds the request up: the conversation and the person's message are written at once,
the diagnosis runs in the background and lands as a ``diagnosis`` message of its own (its text the bottom
line, ``diagnosis.value.json`` the details), and only then is the request delivered. "Diagnose & fix" is the
same request with nobody asked and ``purpose=repair``: private, repairs what it can, and offers Report it
when someone else owns the fix (``DiagnosisSpec.reportable``).
"""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
import uuid
from pathlib import Path
from typing import Optional

import httpx
from pydantic import ValidationError

from flow_sdk.actions.action_registry import action
from flow_sdk.api.api_types.identifier import is_valid_entity_id, mint_uuid
from flow_sdk.app.actions.share_action import LOCAL_MODE_SHARE_MESSAGE, _local_mode_share_blocked
from flow_sdk.app.automation_message import Upload, post_message, value_json
from flow_sdk.builtin.conversation import Conversation, ConversationKind
from flow_sdk.builtin.conversation_channel import DIAGNOSIS
from flow_sdk.builtin.flow_message import (
    HELP_REQUEST_FILE,
    DeliveryStatus,
    FlowMessage,
    FlowMessageKind,
    carrier_attachment,
    delivery_rank,
)
from flow_sdk.builtin.task import Task
from flow_sdk.cloud_client.shared.errors import HubError
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.db.drivers.query import QueryFilter
from flow_sdk.request_context.methods import get_current_request_info, request_fields
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse
from flow_sdk.schema.data_spec.help_request_spec import (
    AskForHelpRequest,
    HelpOrigin,
    HelpRecipient,
    HelpRecipientKind,
    HelpRequestCarrier,
    HelpSend,
)
from flow_sdk.schema.data_spec.hub_failure_spec import HubFailure, HubFailureKind

logger = logging.getLogger(__name__)

#: The ticket beside a people conversation is derived from its id, so a retry finds it again.
_DESK_NAMESPACE = uuid.UUID("6f1d3c52-6a8e-4c43-9a0e-4f2b9d3e7a11")


def desk_conversation_id(conversation_id: str) -> str:
    return mint_uuid(conversation_id, namespace=_DESK_NAMESPACE)


#: Diagnoses running for a request: held here so a finished request is never garbage-collected mid-run.
_DIAGNOSING: set[asyncio.Task] = set()

#: The hub capability that lets a ticket be opened under the id this machine minted (hub f9ff57ace).
IDEMPOTENT_TICKETS = "idempotent_guest_conversation"


# ---------------------------------------------------------------------------
# ask-for-help: a conversation and ONE help_request message
# ---------------------------------------------------------------------------

#: A diagnosis travels as ``diagnosis.value.json``: a ``.value.json`` opens in its kind's viewer.
DIAGNOSIS_FILE = "diagnosis.value.json"
#: The context a help request can carry, in the order the review lists it.
CONTEXT_FILES = (DIAGNOSIS_FILE, "screen.value.json", "session.value.json", "logs.txt")


def _parse_request(body: dict) -> AskForHelpRequest:
    """The request from a JSON body, or from the ``request`` field of a multipart one (with files)."""
    return AskForHelpRequest.model_validate({k: v for k, v in request_fields(body).items() if k != "files"})


@action.post(action_name="ask-for-help", types=None)
async def ask_for_help() -> ApiResponse:
    """Capture the context, diagnose, write the request here, then try the hub once (unless the person
    chose to review it first). SUCCESS whenever the request is written."""
    request_info = get_current_request_info()
    if not request_info or not request_info.someone_typeid:
        return ApiFailResponse(message="No authenticated user in request context")
    body = await request_info.get_post_data() or {}
    try:
        ask = _parse_request(body)
    except (ValidationError, ValueError) as e:
        return ApiFailResponse(message=f"Invalid help request: {e}", status_code=400)
    if not ask.text.strip():
        return ApiFailResponse(message="Say what you need help with", status_code=400)
    if ask.conversation_id and not is_valid_entity_id(ask.conversation_id):
        return ApiFailResponse(message="conversation_id must be a UUID (v4/v5)", status_code=400)
    if ask.recipients and ask.send is HelpSend.WHEN_DIAGNOSED and _local_mode_share_blocked():
        return ApiFailResponse(message=LOCAL_MODE_SHARE_MESSAGE, status_code=403)
    recorded = await _recorded(ask.diagnosis_id) if ask.diagnosis_id else None
    if ask.diagnosis_id and recorded is None:
        return ApiFailResponse(message=f"diagnosis {ask.diagnosis_id} not found", status_code=404)

    someone = request_info.someone_typeid
    # People share one conversation; a desk gets its own ticket (a desk conversation cannot also hold a
    # person). Both carry the same request and the same context, captured -- and diagnosed -- once.
    base = ask.conversation_id or mint_uuid()
    asks = [ask.model_copy(update={"conversation_id": base})]
    if ask.desk is not None and ask.people:
        asks = [
            ask.model_copy(update={"conversation_id": base, "recipients": ask.people}),
            ask.model_copy(update={"conversation_id": desk_conversation_id(base), "recipients": [ask.desk]}),
        ]
    # The diagnosis runs after the request is written, never inside it (``_diagnose_then_deliver``).
    background = ask.diagnose and recorded is None
    capture = ask.model_copy(update={"diagnose": False}) if background else ask
    context: Optional[dict[str, bytes]] = None
    answers = []
    for one in asks:
        conv, task, created = await _capture_conversation(one, someone)
        opening = await _opening_message(conv)
        if opening is None:
            if context is None:
                context = await capture_context(capture, recorded)
            sent = await _write_request(conv, task, one, body.get("files"), context, someone, diagnosing=background)
            if not isinstance(sent, ApiSuccessResponse):
                if created:  # nothing of this request may stay behind half-written
                    await _discard(conv, task)
                return sent
            opening = await FlowMessage.get_one({"id": sent.data["id"]})
        answers.append((conv, task, opening))

    if background:
        run = asyncio.create_task(
            _diagnose_then_deliver([c.id for c, _t, _o in answers], ask, someone), name=answers[0][0].id
        )
        _DIAGNOSING.add(run)
        run.add_done_callback(_DIAGNOSING.discard)
    else:
        for conv, _task, _opening in answers:
            if conv.hub_bound:
                await _first_delivery(conv, "ask-for-help")
    conv, task, opening = answers[0]
    opening = await FlowMessage.get_one({"id": opening.id})
    return ApiSuccessResponse(
        data={
            "conversation_id": conv.id,
            "task_id": task.id if task else None,
            "message_id": opening.id,
            "delivery": _delivery(opening),
            "shared": conv.hub_bound,
            "context_shared": bool(_carrier_of(opening).context_shared),
            "diagnosing": background,
            #: The desk's own ticket, when people were asked too.
            "also": [c.id for c, _t, _o in answers[1:]],
        }
    )


# ---------------------------------------------------------------------------
# The context: captured on the click, shared only when the person says so
# ---------------------------------------------------------------------------


async def _recorded(diagnosis_id: str):
    """A diagnosis taken earlier, as the value that is sent."""
    from flow_sdk.app.actions.diagnose_action import diagnosis_value, recorded_diagnosis  # noqa: PLC0415

    record = await recorded_diagnosis(diagnosis_id)
    return await diagnosis_value(record) if record is not None else None


async def capture_context(ask: AskForHelpRequest, recorded=None) -> dict[str, bytes]:
    """The context files of a request: where the person was, the session on screen, the recent logs, and --
    when asked -- the diagnosis (``run_diagnose`` never raises: a failing diagnose answers its baseline).
    Every file the person left out in the review is dropped here, before anything is written."""
    from flow_sdk.diagnose import DiagnosePurpose, build_flow_context, run_diagnose  # noqa: PLC0415
    from flow_sdk.diagnose.baseline import log_tails  # noqa: PLC0415

    ctx = await build_flow_context(
        purpose=DiagnosePurpose.REPORT,
        project_id=ask.project_id,
        process=ask.process,
        user_report=ask.text,
        origin=ask.origin.value,
        connection_id=ask.connection_id,
    )
    files: dict[str, bytes] = {}
    diagnosis = recorded
    if diagnosis is None and ask.diagnose:
        to = ", ".join(r.name or r.email or "the help desk" for r in ask.recipients) or "you"
        diagnosis = await run_diagnose(ctx, label=f"Diagnosing for {to}")
    if diagnosis is not None:
        files[DIAGNOSIS_FILE] = value_json(diagnosis.model_copy(update={"logs": [], "context": None}))
    files["screen.value.json"] = value_json(ctx.model_copy(update={"session": None, "other_sessions": []}))
    if ctx.session is not None or ctx.other_sessions:
        files["session.value.json"] = value_json(ctx)
    logs = diagnosis.logs if diagnosis is not None and diagnosis.logs else await asyncio.to_thread(log_tails)
    if logs:
        files["logs.txt"] = "\n\n".join(f"== {t.file}\n" + "\n".join(t.lines) for t in logs).encode("utf-8")
    left_out = set(ask.left_out)
    return {name: content for name, content in files.items() if name not in left_out}


def _held_dir(conv_id: str) -> Path:
    """Where a request's unshared context waits, on this computer only."""
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    return get_instance_settings().instance_dir / "help_requests" / conv_id


def _hold(conv_id: str, context: dict[str, bytes]) -> None:
    folder = _held_dir(conv_id)
    folder.mkdir(parents=True, exist_ok=True)
    for name, content in context.items():
        (folder / name).write_bytes(content)


def held_context(conv_id: str) -> dict[str, bytes]:
    """The context captured for this conversation and not shared yet -- empty once shared."""
    folder = _held_dir(conv_id)
    if not folder.is_dir():
        return {}
    return {name: (folder / name).read_bytes() for name in CONTEXT_FILES if (folder / name).is_file()}


def _carrier_of(fm: Optional[FlowMessage]) -> HelpRequestCarrier:
    """What a help request message says of itself (its ``help_request.value.json``), from its local copy."""
    from flow_sdk.fs_store.type_id import TypeId  # noqa: PLC0415
    from flow_sdk.storage import get_entity_embedded_storage  # noqa: PLC0415

    a = carrier_attachment(fm) if fm else None
    if a is None:
        return HelpRequestCarrier()
    try:
        storage = get_entity_embedded_storage(TypeId(type="flow_message", id=fm.id))
        raw = json.loads(Path(storage.get_storage_path(a.data)).read_text(encoding="utf-8"))
        return HelpRequestCarrier.model_validate({k: v for k, v in raw.items() if k != "spec_kind"})
    except Exception:  # noqa: BLE001 — an unreadable carrier is an unshared one
        return HelpRequestCarrier()


async def _send_help_message(
    conv,
    text: str,
    context: dict[str, bytes],
    someone,
    *,
    extra: Optional[dict] = None,
    diagnosing: bool = False,
    pass_on: str = "",
):
    """A ``help_request`` message: its carrier, the shared context as files, plus ``extra`` body fields
    (the person's own files, chips). The one writer Ask, Share and Report go through."""
    from flow_sdk.app.actions.notification_action import handle_add_message  # noqa: PLC0415

    carrier = HelpRequestCarrier(
        title=conv.title or "",
        context=list(context),
        context_shared=bool(context),
        diagnosing=diagnosing,
        pass_on=pass_on,
    )
    extra = dict(extra or {})
    files = [Upload(HELP_REQUEST_FILE, value_json(carrier)), *(Upload(n, c) for n, c in context.items())]
    body = {
        "conversation_id": conv.id,
        "text": text,
        "kind": FlowMessageKind.HELP_REQUEST.value,
        **extra,
        "files": [*files, *extra.get("files", [])],
    }
    return await handle_add_message(body, someone)


async def _first_delivery(conv: Conversation, tag: str) -> None:
    """One delivery attempt now; the outbox owns every later one. Its outcome never changes the answer."""
    try:
        await conv.deliver(bodies=False)
        conv.kick_delivery()
    except Exception as e:  # noqa: BLE001
        logger.warning("[%s] first delivery of %s failed: %s", tag, conv.id, e, exc_info=True)


def _shares_context(ask: AskForHelpRequest) -> bool:
    """The person sends the context with the request -- else it waits here for Share or Report."""
    return ask.share_context and ask.send is HelpSend.WHEN_DIAGNOSED and bool(ask.recipients)


async def _write_request(
    conv, task, ask: AskForHelpRequest, files, context: dict[str, bytes], someone, *, diagnosing: bool = False
):
    """The request message, through the same send every message takes. Its context goes with it only when
    the person shares it; otherwise it waits here (``help-request-share``)."""
    shared = _shares_context(ask)
    if context and not shared:
        await asyncio.to_thread(_hold, conv.id, context)
    chips = [*ask.context, *([str(task.typeid)] if task else [])]
    text = ask.text.strip()
    asked_title = ask.title.strip()
    if task and asked_title and task.title != asked_title and text.startswith(asked_title):
        # The task took the next free title ("… (2)"): the message names the task it carries.
        text = task.title + text[len(asked_title) :]
    user_files = files if isinstance(files, list) else ([files] if files else [])
    extra = {"files": user_files, **({"asset_references": chips, "shared_context_entities": chips} if chips else {})}
    return await _send_help_message(conv, text, context if shared else {}, someone, extra=extra, diagnosing=diagnosing)


# ---------------------------------------------------------------------------
# The diagnosis: in the background, then a message of its own
# ---------------------------------------------------------------------------


def bottom_line(d) -> str:
    """The one line a diagnosis message leads with: what happened, and whose it is."""
    from flow_sdk.schema.data_spec.diagnose_spec import DiagnosisCause, DiagnosisStatus  # noqa: PLC0415

    if d.status in (DiagnosisStatus.OK, DiagnosisStatus.INFORMATIONAL):
        return d.title or d.summary or "Nothing wrong found."
    if d.cause is DiagnosisCause.FLOWPAD:
        return "This is a Flowpad bug — not something in your project."
    if d.cause is DiagnosisCause.DEPENDENCY:
        name = d.cause_asset or "a dependency"
        return f"This comes from {name}, a dependency — not Flowpad."
    if d.cause is DiagnosisCause.UNKNOWN:
        return "The cause is unclear — Flowpad support can look into it."
    if d.status is DiagnosisStatus.FIXED:
        return "Fixed: " + (d.title or d.fix or d.summary)
    return "In your " + ("project" if d.cause is DiagnosisCause.PROJECT else "computer") + ": " + (d.title or d.summary)


#: "Diagnose & fix" is the person asking for the fix -- the diagnose agent otherwise only reports.
_REPAIR_ASK = (
    "The person pressed Diagnose & fix on this error: they ASKED you to fix it. Repair the cause when the "
    "repair is safe and reversible -- a broken file in their own project included (the skill's one-file "
    "repair). Never edit a dependency's files (every folder the project's flow.json names -- a file: one too "
    "-- a package, an external library): "
    "they belong to someone else -- record --cause dependency with --cause-asset, and leave them as found."
)


async def _dependencies_said(project_id: Optional[str]) -> str:
    """The project's dependency folders, as a fact for the repair agent: which files are not the person's."""
    from flow_sdk.builtin.project import Project  # noqa: PLC0415

    project = await Project.get_by_id(project_id) if project_id else None
    deps = project.direct_context_roots()[1:] if project is not None else []
    if not deps:
        return ""
    listed = "\n".join(f"- {path}" for path in deps)
    return f"\n\nThis project's dependencies -- not the person's files, never edit them:\n{listed}"


async def _diagnose(ask: AskForHelpRequest):
    """The request's diagnosis. ``repair`` runs the repairing agent (``flow diagnose``'s runner, which also
    posts its Home-feed card); ``report`` runs the describing one. Neither raises: a failed run answers the
    baseline the checks found."""
    from flow_sdk.diagnose import DiagnosePurpose, build_flow_context, run_diagnose  # noqa: PLC0415
    from flow_sdk.schema.data_spec.diagnose_spec import DiagnosisSpec  # noqa: PLC0415

    if ask.purpose is DiagnosePurpose.REPAIR:
        from flow_sdk.agentic_run_consts import DEFAULT_TRANSCRIPT_TIMEOUT_S  # noqa: PLC0415
        from flow_sdk.cli.commands.diagnose_cmd import _run_diagnose  # noqa: PLC0415

        done: list[dict] = []

        def emit(event: dict | None) -> None:
            if event and event.get("type") == "done":
                done.append(event)

        await _run_diagnose(
            ask.text,
            DEFAULT_TRANSCRIPT_TIMEOUT_S,
            emit=emit,
            prompt_extra=_REPAIR_ASK + await _dependencies_said(ask.project_id),
            project_id=ask.project_id,
            connection_id=ask.connection_id,
            feed=False,
        )
        raw = (done[-1].get("diagnosis") if done else None) or {}
        diagnosis = DiagnosisSpec.model_validate({k: v for k, v in raw.items() if k != "spec_kind"}) if raw else None
        return diagnosis, (done[-1].get("diagnosis_id") if done else None)
    ctx = await build_flow_context(
        purpose=DiagnosePurpose.REPORT,
        project_id=ask.project_id,
        process=ask.process,
        user_report=ask.text,
        origin=ask.origin.value,
        connection_id=ask.connection_id,
    )
    to = ", ".join(r.name or r.email or "the help desk" for r in ask.recipients) or "you"
    return await run_diagnose(ctx, label=f"Diagnosing for {to}"), None


async def _diagnose_then_deliver(conv_ids: list[str], ask: AskForHelpRequest, someone) -> None:
    """Diagnose, post the diagnosis into each of the request's conversations, then deliver them. The
    diagnosis goes with the request only when the person shares the context; otherwise it waits here."""
    try:
        diagnosis, diagnosis_id = await _diagnose(ask)
    except Exception:  # noqa: BLE001 — the request stands without its diagnosis
        logger.warning("[ask-for-help] diagnosis failed", exc_info=True)
        diagnosis, diagnosis_id = None, None
    for conv_id in conv_ids:
        conv = await Conversation.get_one({"id": conv_id})
        if conv is None:
            continue
        try:
            await _post_diagnosis(conv, ask, diagnosis, diagnosis_id, someone)
        except Exception:  # noqa: BLE001
            logger.warning("[ask-for-help] posting the diagnosis into %s failed", conv_id, exc_info=True)
        if conv.hub_bound:
            await _first_delivery(conv, "ask-for-help")


async def _post_diagnosis(conv, ask: AskForHelpRequest, diagnosis, diagnosis_id, someone) -> None:
    if diagnosis is None:
        text, files = "The diagnosis could not run. You can still report it.", {}
    else:
        text = bottom_line(diagnosis)
        files = {DIAGNOSIS_FILE: value_json(diagnosis.model_copy(update={"logs": [], "context": None}))}
    shared = _shares_context(ask) and DIAGNOSIS_FILE not in set(ask.left_out)
    if files and not shared:
        await asyncio.to_thread(_hold, conv.id, files)
    await post_message(
        conv.id, text,
        kind=FlowMessageKind.DIAGNOSIS,
        sender_name="Flowpad Diagnosis",
        someone=someone,
        # Private: the details stay here until Report or Share; the bottom line is all the message holds.
        files=files if shared else None,
        asset_references=[f"flowpad_diagnosis-{diagnosis_id}"] if diagnosis_id else None,
    )


def _held_diagnosis(conv_id: str):
    from flow_sdk.schema.data_spec.diagnose_spec import DiagnosisSpec  # noqa: PLC0415

    raw = held_context(conv_id).get(DIAGNOSIS_FILE)
    if not raw:
        return None
    try:
        data = json.loads(raw)
        return DiagnosisSpec.model_validate({k: v for k, v in data.items() if k != "spec_kind"})
    except (ValueError, ValidationError):
        return None


async def _report_target(conv, diagnosis) -> tuple[Optional[str], str, str]:
    """Where Report it sends the request: ``(desk queue id, its name, pass_on)``. A dependency with a desk
    of its own goes there; anything else to Flowpad support -- a dependency without a desk with ``pass_on``,
    so support knows to report it upstream."""
    from flow_sdk.app.actions.flow_message_action import _hub_default_helpdesk, _last_known_desk  # noqa: PLC0415
    from flow_sdk.app.helpdesk_resolver import resolve_adopted_helpdesk  # noqa: PLC0415
    from flow_sdk.schema.data_spec.diagnose_spec import DiagnosisCause  # noqa: PLC0415

    asset = (diagnosis.cause_asset if diagnosis else "") or ""
    if diagnosis is not None and diagnosis.cause is DiagnosisCause.DEPENDENCY and conv.origin_project_id:
        adopted = await resolve_adopted_helpdesk(conv.origin_project_id)
        if adopted is not None and asset and asset.lower() in adopted.mount_path.lower():
            return adopted.queue_project_id, f"{asset}'s help desk", ""
    support = await _hub_default_helpdesk() or _last_known_desk()
    pass_on = asset if diagnosis is not None and diagnosis.cause is DiagnosisCause.DEPENDENCY else ""
    return (support.project_id if support else None), "Flowpad support", pass_on


@action.post(action_name="help-request-report", types=["conversation"])
async def help_request_report() -> ApiResponse:
    """``POST /graph/conversation/<id>/help-request-report`` — Report it: the private request becomes a ticket
    in the desk its diagnosis points at, and everything held here (the diagnosis, the screen, the logs) goes
    with it, in this same conversation."""
    request_info = get_current_request_info()
    if not request_info or not request_info.target_entity_typeid or not request_info.someone_typeid:
        return ApiFailResponse(message="help-request-report: target conversation required", status_code=400)
    conv = await Conversation.get_one({"id": request_info.target_entity_typeid.id})
    if conv is None:
        return ApiFailResponse(message="Conversation not found", status_code=404)
    if conv.members:
        return ApiFailResponse(message="This request already has people in it: use Share", status_code=400)
    if _local_mode_share_blocked():
        return ApiFailResponse(message=LOCAL_MODE_SHARE_MESSAGE, status_code=403)
    someone = request_info.someone_typeid
    diagnosis = _held_diagnosis(conv.id)
    desk_id, desk_name, pass_on = await _report_target(conv, diagnosis)
    if conv.kind not in (ConversationKind.HELPDESK, ConversationKind.HELPDESK.value):
        conv.kind = ConversationKind.HELPDESK
        conv.remote_project_id = desk_id  # None: resolved at delivery, like any ticket asked offline
    conv.awaits_hub = True
    conv = await conv.save(someone)
    context = held_context(conv.id)
    line = f"Reported to {desk_name}" + (f" — please pass it on to {pass_on}" if pass_on else "")
    sent = await _send_help_message(conv, line, context, someone, pass_on=pass_on)
    if not isinstance(sent, ApiSuccessResponse):
        return sent
    await asyncio.to_thread(shutil.rmtree, _held_dir(conv.id), True)
    await _first_delivery(conv, "help-request-report")
    return ApiSuccessResponse(
        data={"conversation_id": conv.id, "message_id": sent.data["id"], "desk": desk_name, "pass_on": pass_on}
    )


@action.post(action_name="help-request-share", types=["conversation"])
async def help_request_share() -> ApiResponse:
    """``POST /graph/conversation/<id>/help-request-share`` — the person's Share: a request kept on this
    computer goes to the hub, and its held context follows as a help request message of its own."""

    request_info = get_current_request_info()
    if not request_info or not request_info.target_entity_typeid or not request_info.someone_typeid:
        return ApiFailResponse(message="help-request-share: target conversation required", status_code=400)
    conv = await Conversation.get_one({"id": request_info.target_entity_typeid.id})
    if conv is None:
        return ApiFailResponse(message="Conversation not found", status_code=404)
    if not conv.members and conv.kind not in (ConversationKind.HELPDESK, ConversationKind.HELPDESK.value):
        return ApiFailResponse(
            message="Nobody to share it with: add someone to the conversation first", status_code=400
        )
    if _local_mode_share_blocked():
        return ApiFailResponse(message=LOCAL_MODE_SHARE_MESSAGE, status_code=403)
    fields = request_fields(await request_info.get_post_data() or {})
    left_out = set(fields.get("left_out") or [])
    context = {n: c for n, c in held_context(conv.id).items() if n not in left_out}
    someone = request_info.someone_typeid
    if not conv.hub_bound:
        conv.awaits_hub = True
        conv = await conv.save(someone)
    message_id = None
    if context:
        sent = await _send_help_message(conv, "Shared the context: " + ", ".join(context), context, someone)
        if not isinstance(sent, ApiSuccessResponse):
            return sent
        message_id = sent.data["id"]
        await asyncio.to_thread(shutil.rmtree, _held_dir(conv.id), True)
    await _first_delivery(conv, "help-request-share")
    return ApiSuccessResponse(data={"conversation_id": conv.id, "message_id": message_id, "shared": list(context)})


@action.post(action_name="help-request-context", types=["conversation"])
async def help_request_context() -> ApiResponse:
    """``POST /graph/conversation/<id>/help-request-context`` — the context held for a request, for the review
    before it is shared (``AssetReviewDialog`` in send mode)."""
    request_info = get_current_request_info()
    if not request_info or not request_info.target_entity_typeid:
        return ApiFailResponse(message="help-request-context: target conversation required", status_code=400)
    conv_id = request_info.target_entity_typeid.id
    held = held_context(conv_id)
    conv = await Conversation.get_one({"id": conv_id})
    return ApiSuccessResponse(
        data={
            "items": [{"name": n, "content": c.decode("utf-8", errors="replace")} for n, c in held.items()],
            # Nobody to share with yet: Share has nowhere to go -- Report it (on the diagnosis) is the way out.
            "private": conv is not None and not conv.members and not _is_ticket(conv),
        }
    )


def _is_ticket(conv) -> bool:
    return conv.kind in (ConversationKind.HELPDESK, ConversationKind.HELPDESK.value)


def _desk_replied(messages) -> bool:
    """Whether the last word in a reported request is someone else's — the help desk answered. The asker
    is whoever sent the request; Flowpad's own lines (the request, the diagnosis) are never an answer."""
    asker = next((m.sender_id for m in messages if _kind(m) == FlowMessageKind.HELP_REQUEST.value), None)
    last = messages[-1] if messages else None
    # Flowpad's own lines (the request, the diagnosis, "Reported to …") go out under the asker's id.
    return bool(last and asker and last.sender_id not in (None, asker))


def _kind(fm) -> str:
    return getattr(fm.kind, "value", fm.kind)


async def _posted_diagnosis(conv, messages=None):
    """The diagnosis a request's diagnosis message carries (shared), else the one held here (private)."""
    from flow_sdk.fs_store.type_id import TypeId  # noqa: PLC0415
    from flow_sdk.schema.data_spec.diagnose_spec import DiagnosisSpec  # noqa: PLC0415
    from flow_sdk.storage import get_entity_embedded_storage  # noqa: PLC0415

    held = _held_diagnosis(conv.id)
    if held is not None:
        return held, True
    posted = False
    for fm in reversed(messages if messages is not None else await conv.messages()):
        if _kind(fm) != FlowMessageKind.DIAGNOSIS.value:
            continue
        posted = True
        for a in fm.attachment or []:
            if str(a.data).rsplit("/", 1)[-1] != DIAGNOSIS_FILE:
                continue
            try:
                path = get_entity_embedded_storage(TypeId(type="flow_message", id=fm.id)).get_storage_path(a.data)
                raw = json.loads(Path(path).read_text(encoding="utf-8"))
                return DiagnosisSpec.model_validate({k: v for k, v in raw.items() if k != "spec_kind"}), True
            except (OSError, ValueError, ValidationError):
                break
    return None, posted


@action.post(action_name="help-request-diagnosis", types=["conversation"])
async def help_request_diagnosis() -> ApiResponse:
    """``POST /graph/conversation/<id>/help-request-diagnosis`` — what the diagnosis message offers: its
    verdict, whether a report is offered and to whom (``desk``, ``pass_on``), and whether it is still running."""
    request_info = get_current_request_info()
    if not request_info or not request_info.target_entity_typeid:
        return ApiFailResponse(message="help-request-diagnosis: target conversation required", status_code=400)
    conv = await Conversation.get_one({"id": request_info.target_entity_typeid.id})
    if conv is None:
        return ApiFailResponse(message="Conversation not found", status_code=404)
    messages = await conv.messages()  # read once: the diagnosis and the desk's last word both come from it
    diagnosis, posted = await _posted_diagnosis(conv, messages)
    reported = _is_ticket(conv) or bool(conv.members)
    desk, pass_on = "", ""
    if diagnosis is not None and diagnosis.reportable and not reported:
        _id, desk, pass_on = await _report_target(conv, diagnosis)
    return ApiSuccessResponse(
        data={
            "diagnosing": not posted and any(t for t in _DIAGNOSING if t.get_name() == conv.id),
            "diagnosis": diagnosis.model_dump(mode="json") if diagnosis is not None else None,
            "reportable": bool(diagnosis is not None and diagnosis.reportable and not reported),
            "reported": reported,
            "replied": reported and _desk_replied(messages),
            "desk": desk,
            "pass_on": pass_on,
        }
    )


@action.post(action_name="help-request-preview", types=None)
async def help_request_preview() -> ApiResponse:
    """``POST {request}`` — what Ask would attach, before anything is written: the dialog's Review, and a
    suggested title. Diagnoses only when the request asks to."""
    request_info = get_current_request_info()
    body = (await request_info.get_post_data() or {}) if request_info else {}
    try:
        ask = _parse_request(body)
    except (ValidationError, ValueError) as e:
        return ApiFailResponse(message=f"Invalid help request: {e}", status_code=400)
    # The title and the context are independent waits (a model, a diagnose): take them together.
    context, title = await asyncio.gather(
        capture_context(ask.model_copy(update={"left_out": []})), suggest_title(ask.text)
    )
    return ApiSuccessResponse(
        data={
            "title": title,
            "items": [{"name": n, "content": c.decode("utf-8", errors="replace")} for n, c in context.items()],
        }
    )


async def suggest_title(text: str) -> str:
    """A short title for a request: a small, fast model when one answers, else the ticket rule."""
    from flow_sdk.app.actions.flow_message_action import _ticket_title  # noqa: PLC0415
    from flow_sdk.external_apis.llm.simple_llm import llm_completion  # noqa: PLC0415

    fallback = _ticket_title(text) if text.strip() else ""
    if not text.strip():
        return fallback
    try:
        answer = await llm_completion(
            "Write a title of at most 8 words for this help request. Reply with the title only.",
            text[:2000],
            model="anthropic/claude-haiku-4.5",
        )
    except Exception:  # noqa: BLE001 — best effort by contract
        answer = ""
    line = (answer or "").strip().splitlines()[0].strip(' "') if isinstance(answer, str) and answer.strip() else ""
    return line[:80] or fallback


def member_of(recipient) -> dict:
    """A person recipient as a conversation member: only the fields it has."""
    return {
        k: v for k, v in (("email", recipient.email), ("user_id", recipient.user_id), ("name", recipient.name)) if v
    }


def _is_diagnosis(ask: AskForHelpRequest) -> bool:
    """A private request Flowpad diagnoses for a warning or an error (Diagnose & fix): its conversation lives
    on the Diagnosis channel, and stays there when it is reported to a help desk."""
    from flow_sdk.diagnose import DiagnosePurpose  # noqa: PLC0415

    return ask.purpose is DiagnosePurpose.REPAIR or ask.origin is HelpOrigin.WARNING


async def _capture_conversation(ask: AskForHelpRequest, someone) -> tuple[Conversation, Optional[Task], bool]:
    """The request's conversation (and task, for a person) — found by the asker's id, or written.
    A desk makes it a ticket; people make it their conversation; nobody makes it private (never sent)."""
    conv_id = ask.conversation_id or mint_uuid()
    conv = await Conversation.get_one({"id": conv_id})
    task = await _task_of(conv_id) if ask.people else None
    if conv is not None:
        return conv, task, False

    desk = ask.desk
    if desk is not None:
        from flow_sdk.app.actions.flow_message_action import _ticket_title, resolve_desk_here  # noqa: PLC0415

        desk_id = desk.desk_project_id
        if not desk_id:
            known = await resolve_desk_here(ask.project_id)
            desk_id = known.project_id if known else None  # unknown offline: resolved at delivery
        conv = Conversation(
            id=conv_id,
            title=ask.title.strip() or _ticket_title(ask.text),
            kind=ConversationKind.HELPDESK,
            remote_project_id=desk_id,
        )
    elif ask.people:
        task = await _write_task(ask, conv_id, someone)
        conv = Conversation(id=conv_id, title=task.title, members=[member_of(p) for p in ask.people])
    else:
        from flow_sdk.app.actions.flow_message_action import _ticket_title  # noqa: PLC0415

        conv = Conversation(id=conv_id, title=ask.title.strip() or _ticket_title(ask.text))
        if _is_diagnosis(ask):
            conv.channel = DIAGNOSIS.name
    conv.awaits_hub = bool(ask.recipients) and ask.send is HelpSend.WHEN_DIAGNOSED
    conv.origin_project_id = ask.project_id
    conv = await conv.save(someone)
    return conv, task, True


async def _task_of(conv_id: str) -> Optional[Task]:
    rows = await Task.get_all(QueryFilter(match={"origin_conversation": conv_id}, limit=1))
    return rows[0] if rows else None


async def _write_task(ask: AskForHelpRequest, conv_id: str, someone) -> Task:
    """The task a person is asked to do, in the project the asker was in — under the title asked,
    or the next free one ("… (2)") when a task already has it."""
    from flow_sdk.builtin.project import Project  # noqa: PLC0415
    from flow_sdk.schema.data_spec.task_spec import TaskKind  # noqa: PLC0415

    project = await Project.get_by_id(ask.project_id) if ask.project_id else None
    mount = getattr(project, "fs_storage_mount_path", None) if project else None
    base = (ask.title or ask.text.splitlines()[0]).strip()[:80] or "Help request"
    recipient = ask.people[0]
    for n in range(1, 21):
        task = Task(
            title=base if n == 1 else f"{base} ({n})",
            description=ask.text,
            kind=TaskKind.VIBE,
            assignee=recipient.email or recipient.user_id,
            origin_conversation=conv_id,
        )
        if project is not None:
            task.project_id = project.id
        try:
            if mount:
                await task._prepare_for_storage(scope_root=Path(mount))  # noqa: SLF001 — the placement seam
            return await task.save(someone)
        except Exception as e:  # noqa: BLE001
            if "exist" not in str(e).lower():
                raise
    raise RuntimeError(f"no free task title for {base!r}")


async def _opening_message(conv: Conversation) -> Optional[FlowMessage]:
    """The request's first message, when an earlier send of the same request already wrote it --
    the first of mine, since a diagnosis may follow it."""
    return next((fm for fm in await conv.messages() if fm.written_here), None)


async def _discard(conv: Conversation, task: Optional[Task]) -> None:
    for row in (conv, task):
        if row is None:
            continue
        try:
            await row.delete()
        except Exception as e:  # noqa: BLE001
            logger.warning("[ask-for-help] could not remove the half-written %s %s: %s", row.get_type(), row.id, e)


def _delivery(fm: FlowMessage) -> dict:
    failure = fm.delivery_failure
    return {
        "header": fm.delivery_status,
        "body": getattr(fm.body_status, "value", fm.body_status),
        "failure": failure.model_dump(mode="json") if failure and fm.owes_delivery else None,
    }


# ---------------------------------------------------------------------------
# Stage 0 of Conversation.deliver: put a captured request on the hub
# ---------------------------------------------------------------------------


async def open_on_hub(conv: Conversation, opening: FlowMessage) -> Optional[HubFailure]:
    """Create on the hub the conversation a request was captured in — ``None`` once it is there.

    A desk ask opens a ticket under the id minted here (with its opening message, which is then
    SENT). A person ask puts the task on the hub and gives it to them, then shares the
    conversation with them; the opening message follows in stage 1. Every step is safe to repeat.
    """
    try:
        if conv.kind == ConversationKind.HELPDESK.value or conv.kind == ConversationKind.HELPDESK:
            failure = await _open_ticket(conv, opening)
            if failure is not None:
                return failure
        else:
            await _open_person_ask(conv, opening)
    except HubError as e:
        return e.failure
    except httpx.HTTPError as e:  # a hop that does not speak HubError yet (Entity.share's client)
        return HubFailure(kind=HubFailureKind.OFFLINE, message=f"Can't reach the hub right now ({type(e).__name__}).")
    except Exception as e:  # noqa: BLE001 — the reason must land on the message, not in a log
        logger.warning("[ask-for-help] opening on the hub failed: %s", e, exc_info=True)
        return HubFailure(kind=HubFailureKind.SERVER_ERROR, message=str(e) or type(e).__name__)
    conv.awaits_hub = False
    conv.remote = True
    await conv.save()
    from flow_sdk.cloud_client.hub_bridge import hub_ws_bridge  # noqa: PLC0415

    hub_ws_bridge.remember_hub_conversation(conv.id)
    return None


async def _open_ticket(conv: Conversation, opening: FlowMessage) -> Optional[HubFailure]:
    from flow_sdk.app.actions.flow_message_action import resolve_helpdesk  # noqa: PLC0415
    from flow_sdk.cloud_client.hub_proxy import HubProxy  # noqa: PLC0415
    from flow_sdk.cloud_client.transport.hub_http import get_info  # noqa: PLC0415

    info = await get_info()
    if info is None:
        return HubFailure(kind=HubFailureKind.OFFLINE, message="Can't reach the hub right now.")
    if IDEMPOTENT_TICKETS not in (info.get("capabilities") or []):
        # An older hub would ignore our id and open a second ticket on every retry: wait for it.
        return HubFailure(  # passes when the hub is upgraded: retried, not refused
            kind=HubFailureKind.SERVER_ERROR,
            code="hub_too_old",
            message="The help desk needs a newer hub to take this.",
        )
    if not conv.remote_project_id:
        desk = await resolve_helpdesk(conv.origin_project_id)
        if desk is None:
            return HubFailure(
                kind=HubFailureKind.NOT_CONFIGURED, message="This hub has no help desk — ask a person instead."
            )
        conv.remote_project_id = desk.project_id
        await conv.save()

    payload = {
        "conversation_id": conv.id,
        "id": opening.id,
        "text": opening.text,
        "context": [str(c) for c in (opening.shared_context_entities or [])],
        "attachment": [a.model_dump(mode="json") for a in (opening.attachment or [])],
        **({"body_status": "uploading"} if opening.has_body() else {}),
    }
    data = await HubProxy.call(
        "POST",
        BuiltinEntityType.PROJECT,
        conv.remote_project_id,
        "start_guest_conversation",
        payload=payload,
        strict=True,
    )
    if (data or {}).get("id") != conv.id:
        return HubFailure(
            kind=HubFailureKind.REJECTED, code="hub_too_old", message="The hub opened the ticket under another id."
        )
    if data.get("title"):
        conv.title = data["title"]
    if data.get("initiated_by"):
        conv.initiated_by = data["initiated_by"]
    if opening.has_body():
        from flow_sdk.builtin.flow_message import BodyStatus  # noqa: PLC0415

        opening.body_status = BodyStatus.UPLOADING
    await opening.mark_sent()
    return None


async def _open_person_ask(conv: Conversation, opening: FlowMessage) -> None:
    from flow_sdk.app.actions.task_assign_action import assign_on_hub  # noqa: PLC0415
    from flow_sdk.cloud_client.client_hooks import resolve_hub_credential  # noqa: PLC0415

    member = (conv.members or [{}])[0]
    email, user_id = member.get("email"), member.get("user_id")
    task = await _task_of(conv.id)
    if task is not None:
        if not task.reporter:
            task.reporter = await _my_email()
        await assign_on_hub(task, email=email, user_id=user_id, message=opening.text, someone_typeid=None)
    if not await resolve_hub_credential():
        raise HubError(0, "signed out", kind=HubFailureKind.SIGNED_OUT)
    members = conv.members or []
    emails = [m["email"] for m in members if m.get("email")]
    user_ids = [m["user_id"] for m in members if m.get("user_id") and not m.get("email")]
    await conv.share(recipients=emails or None, recipient_user_ids=user_ids or None, deliver_messages=False)


async def _my_email() -> Optional[str]:
    from flow_sdk.cli.auth.credentials import load_credentials  # noqa: PLC0415

    creds = load_credentials()
    return ((creds.user or {}).get("email") if creds else None) or None


# ---------------------------------------------------------------------------
# resend / help-recipients / help-requests
# ---------------------------------------------------------------------------


@action.post(action_name="resend", types=["conversation"])
async def resend() -> ApiResponse:
    """``POST /graph/conversation/<id>/resend`` — the person's Retry: deliver what is owed, including
    what the hub refused before (they may have changed something since)."""
    request_info = get_current_request_info()
    if not request_info or not request_info.target_entity_typeid:
        return ApiFailResponse(message="resend: target conversation required", status_code=400)
    conv = await Conversation.get_one({"id": request_info.target_entity_typeid.id})
    if conv is None:
        return ApiFailResponse(message="Conversation not found", status_code=404)
    await conv.deliver(force=True)
    owed = await conv._owed_messages(force=True)  # noqa: SLF001
    return ApiSuccessResponse(data={"conversation_id": conv.id, "owed": len(owed)})


@action.post(action_name="help-recipients", types=None)
async def help_recipients() -> ApiResponse:
    """The desks this person can ask, nearest first: the project's own desk (a portal), a desk the
    project adopted, then the hub's ("Flowpad support"). ``default_state`` tells the dialog whether
    there is no desk (``not_configured``) or it cannot tell right now (``unknown``)."""
    from flow_sdk.app.actions.flow_message_action import _hub_default_helpdesk  # noqa: PLC0415
    from flow_sdk.app.helpdesk_resolver import resolve_adopted_helpdesk  # noqa: PLC0415
    from flow_sdk.cloud_client.transport.hub_http import get_info  # noqa: PLC0415

    request_info = get_current_request_info()
    body = (await request_info.get_post_data() or {}) if request_info else {}
    project_id = (body.get("project_id") or "").strip() or None

    desks: list[dict] = []
    own = await _portal_queue_id(project_id)
    if own:
        desks.append(
            HelpRecipient(kind=HelpRecipientKind.DESK, desk_project_id=own, name="This help desk").model_dump(
                mode="json"
            )
        )
    adopted = await resolve_adopted_helpdesk(project_id) if project_id else None
    if adopted is not None and adopted.queue_project_id != own:
        desks.append(
            HelpRecipient(
                kind=HelpRecipientKind.DESK, desk_project_id=adopted.queue_project_id, name="This project's help desk"
            ).model_dump(mode="json")
        )
    default = await _hub_default_helpdesk()
    reached = await get_info() is not None
    if default is not None and default.project_id not in {d["desk_project_id"] for d in desks}:
        desks.append(
            HelpRecipient(
                kind=HelpRecipientKind.DESK, desk_project_id=default.project_id, name="Flowpad support"
            ).model_dump(mode="json")
        )
    state = "known" if default is not None else ("not_configured" if reached else "unknown")
    return ApiSuccessResponse(data={"desks": desks, "default_state": state})


async def _portal_queue_id(project_id: Optional[str]) -> Optional[str]:
    """The desk queue a portal project IS (its checkout slot is named by the queue id)."""
    if not project_id:
        return None
    from flow_sdk.builtin.project import Project  # noqa: PLC0415
    from flow_sdk.config import is_helpdesk_portal_path  # noqa: PLC0415

    project = await Project.get_by_id(project_id)
    mount = getattr(project, "fs_storage_mount_path", None) if project else None
    if not mount or not is_helpdesk_portal_path(mount):
        return None
    name = Path(mount).name
    queue = name.removeprefix("project-")
    return queue if is_valid_entity_id(queue) else None


@action.post(action_name="help-requests", types=None)
async def help_requests() -> ApiResponse:
    """My help requests, both kinds, one row shape — including ones not delivered yet."""
    request_info = get_current_request_info()
    body = (await request_info.get_post_data() or {}) if request_info else {}
    project_id = (body.get("project_id") or "").strip() or None
    rows: list[dict] = []

    match = {"origin_project_id": project_id} if project_id else {}
    convs = await Conversation.get_all(QueryFilter(match={"kind": ConversationKind.HELPDESK.value, **match}))
    for conv in convs:
        opening = await _opening_message(conv)
        if opening is None:
            continue  # a ticket someone else opened (the desk side), not my request
        rows.append(_request_row(conv, opening, None))

    task_match = {"kind": "vibe", **({"project_id": project_id} if project_id else {})}
    for task in await Task.get_all(QueryFilter(match=task_match)):
        if not task.origin_conversation:
            continue
        conv = await Conversation.get_one({"id": task.origin_conversation})
        opening = await _opening_message(conv) if conv else None
        if conv is None or opening is None:
            continue
        rows.append(_request_row(conv, opening, task))
    rows.sort(key=lambda row: row.pop("_recency"), reverse=True)
    return ApiSuccessResponse(data={"requests": rows})


def _request_row(conv: Conversation, opening: FlowMessage, task: Optional[Task]) -> dict:
    status = _request_status(conv, task)
    member = (conv.members or [{}])[0] if task else {}
    return {
        "conversation_id": conv.id,
        "task_id": task.id if task else None,
        "kind": "person" if task else "desk",
        "recipient_label": (member.get("name") or member.get("email") or member.get("user_id"))
        if task
        else "Help desk",
        "title": (task.title if task else conv.title) or "",
        "status": status,
        "delivery": _delivery(opening),
        "delivered": delivery_rank(opening.delivery_status) >= delivery_rank(DeliveryStatus.SENT),
        "unread": conv.unread_count or 0,
        "_recency": str(conv.updated_date or ""),
    }


def _request_status(conv: Conversation, task: Optional[Task]) -> str:
    """``open`` | ``resolved`` | ``closed`` — the task decides a person ask, the ticket a desk ask."""
    if task is not None:
        status = str(getattr(task, "status", "") or "").lower()
        if status in ("done", "completed"):
            return "resolved"
        return "closed" if status in ("canceled", "cancelled", "failed") else "open"
    return "resolved" if str(getattr(conv.status, "value", conv.status) or "").lower() == "closed" else "open"
