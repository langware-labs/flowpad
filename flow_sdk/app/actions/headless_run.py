"""Generic headless-run infrastructure.

Drives an invisible ``AgenticProcess`` against an arbitrary anchor entity and
stages the assistant output as a draft ``FlowMessage``. The anchor — Task,
Conversation, or any future entity — is described by a ``HeadlessRunScope``,
so this module never imports the entity classes themselves.

Per-entity wrappers live next to their entity action handlers
(``task_action.py``, ``conversation_action.py``); each builds a scope from
its entity and calls ``run_scope(scope, prompt_text, …)``.

The pipeline:
  1. Resolve a reusable AgenticProcess (preferred id, else target_vfs_path
     match, else spawn fresh invisible process).
  2. Drive ``ClaudeCLIStreamWorker`` headlessly with the prompt; capture
     every FlowData item the worker emits.
  3. Land the process in a terminal status; rewrite cli_config so a later
     PTY open ``--resume``s the saved session interactively.
  4. Extract assistant CHAT text from the captured stream; if non-empty,
     persist it as a draft FlowMessage attached to the scope's conversation.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Optional

from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.cli_drivers import AgenticContext
from flow_sdk.builtin.agentic_process.cli_drivers.claude.cli import ClaudeCliOptions
from flow_sdk.builtin.agentic_process.cli_drivers.claude.stream_worker import (
    ClaudeCLIStreamWorker,
)
from flow_sdk._compat import UTC
from flow_sdk.builtin.flow_message import Attachment, AttachmentType, FlowMessage
from flow_sdk.builtin.run import Run, RunStatus
from flow_sdk.builtin.user import User
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowElementType
from flow_sdk.fs_records.agentic_process_lifecycle import ProcessStatus
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse

from datetime import datetime

logger = logging.getLogger(__name__)


_REUSABLE_PROCESS_STATUSES: frozenset[str] = frozenset({
    ProcessStatus.NEW.value,
    ProcessStatus.STARTING.value,
    ProcessStatus.RUNNING.value,
    # STOPPED is reusable too — between headless turns we mark the process
    # STOPPED in the run finally block so opening it in a PTY later won't get
    # "session already in use", but the same entity should still be reused for
    # the next headless turn (Scenario C continuity). Skip FAILED.
    ProcessStatus.STOPPED.value,
})


@dataclass
class HeadlessRunScope:
    """Anchor entity for a headless run.

    Decouples the run plumbing (Claude session-id handling, FlowData streaming,
    status transitions, draft persistence) from the entity that scopes it.
    Two scopes today: Task (Scenarios A/B/C — `task/<id>/run-headless`) and
    Conversation (hub-direct from homelanding — `conversation/<id>/run-headless`).
    Add new scopes by writing a ``_scope_from_<entity>`` builder next to that
    entity's action handler.

    Fields:
      target_typeid       Pinned to the spawned process as ``target_vfs_path``;
                          surfaces the run in the entity's Runs drawer.
      conversation_id     Where the resulting draft FlowMessage lands.
      workdir             Claude ``--cwd``.
      project_id          Pinned to the spawned process as ``project_id``.
      process_context     ``context_entities`` for the AgenticProcess.
      draft_context       ``context_entities`` + per-typeid attachments for the
                          draft FlowMessage.
      preferred_process_id  When set, prefer this id for reuse before falling
                          back to ``target_vfs_path`` lookup. Tasks set this
                          from ``task.shared_process_id`` (Scenario C pre-fork);
                          conversations leave it None.
      log_label           Prefix for log breadcrumbs.
    """
    target_typeid: TypeId
    conversation_id: str
    workdir: str
    project_id: Optional[str]
    process_context: list[TypeId]
    draft_context: list[TypeId]
    preferred_process_id: Optional[str] = None
    log_label: str = "run-headless"


async def _resolve_or_spawn_process(scope: HeadlessRunScope, someone_typeid: str) -> AgenticProcess:
    """Resolve a reusable AgenticProcess for ``scope``, else spawn a fresh one.

    Reuse priority:
      1. ``scope.preferred_process_id`` when set and live (Scenario C pre-fork).
      2. Any live process whose ``target_vfs_path`` matches ``scope.target_typeid``
         — only consulted when no preferred id was given. This is what gives
         conversation-scoped runs Claude-session continuity across approvals.

    Skipped when neither hits: spawns a fresh invisible AgenticProcess.
    """
    if scope.preferred_process_id:
        existing = await AgenticProcess.get_one({"id": scope.preferred_process_id})
        if existing and existing.status in _REUSABLE_PROCESS_STATUSES:
            if existing.add_context_entities(*scope.process_context):
                try:
                    await existing.save(someone_typeid)
                except Exception:
                    logger.debug("[%s] reuse context_entities save failed", scope.log_label, exc_info=True)
            return existing
    else:
        candidates = await AgenticProcess.get_all({"target_vfs_path": str(scope.target_typeid)}) or []
        for proc in candidates:
            if proc.status in _REUSABLE_PROCESS_STATUSES:
                if proc.add_context_entities(*scope.process_context):
                    try:
                        await proc.save(someone_typeid)
                    except Exception:
                        logger.debug("[%s] reuse context_entities save failed", scope.log_label, exc_info=True)
                return proc

    cli_opts = ClaudeCliOptions(
        print_mode=True,
        output_format="stream-json",
        verbose=True,
        permission_mode="bypassPermissions",
    )
    process = AgenticProcess(
        cli_config=cli_opts.to_json(),
        workdir=scope.workdir,
        visible=False,
        project_id=scope.project_id or None,
        target_vfs_path=str(scope.target_typeid),
        context_entities=scope.process_context,
    )
    await process.save(someone_typeid)
    return process


def _extract_assistant_text(flow_data_items: list) -> str:
    """Concatenate assistant CHAT text from a captured FlowData stream.

    Skips TOOL_CALL / TOOL_RESULT / STATUS / REASONING entries — they are
    transient turn-internal mechanics; only the assistant's user-facing text
    becomes the draft message body.
    """
    parts: list[str] = []
    for fd in flow_data_items:
        attrs = getattr(fd, "attributes", None) or {}
        if attrs.get("element-type") != FlowElementType.CHAT:
            continue
        if attrs.get("role") != "assistant":
            continue
        value = getattr(fd, "flow_value", None)
        if isinstance(value, str) and value:
            parts.append(value)
    if parts:
        return "\n\n".join(parts).strip()

    # Fallback: surface the RESULT event's `result` field when no CHAT text
    # was emitted (rare — typical when the turn finished entirely via tool calls).
    for fd in flow_data_items:
        attrs = getattr(fd, "attributes", None) or {}
        if attrs.get("element-type") != FlowElementType.RESULT:
            continue
        value = getattr(fd, "flow_value", None)
        if isinstance(value, dict):
            result_text = value.get("result")
            if isinstance(result_text, str) and result_text:
                return result_text.strip()
    return ""


CLAUDE_QUOTE_PREFIX = 'Claude said: "'
CLAUDE_QUOTE_SUFFIX = '"'


def _wrap_as_claude_quote(text: str) -> str:
    """Wrap the agent's response so the bubble can italicize it as a quote.

    Format: ``Claude said: "<text>"`` on one line. ``MessageBubble`` detects
    this exact prefix/suffix and renders the quoted middle in ``<em>``. The
    user reviews this draft before sending; they can rewrite freely and the
    bubble falls back to plain rendering once the pattern is broken — so the
    formatting only applies until the user has made the message their own.

    Embedded ``"`` characters in the agent's reply are escaped (`\\"`) so a
    response with inline quotes doesn't terminate our wrapping early.
    """
    escaped = text.replace('\\', '\\\\').replace('"', '\\"')
    return f'{CLAUDE_QUOTE_PREFIX}{escaped}{CLAUDE_QUOTE_SUFFIX}'


async def _save_draft_flow_message(
    *,
    scope: HeadlessRunScope,
    text: str,
    sender_id: Optional[str],
    sender_name: str,
    someone_typeid: str,
) -> Optional[FlowMessage]:
    """Persist captured run output as a draft FlowMessage on ``scope.conversation_id``.

    The draft's ``context_entities`` and per-typeid attachment chips come from
    ``scope.draft_context`` — task scope adds [task, conversation], conversation
    scope adds [conversation] only.
    """
    if not text or not scope.conversation_id:
        return None
    fm = FlowMessage.model_validate({
        "text": _wrap_as_claude_quote(text),
        "context": list(scope.draft_context),
        "attachment": [],
        "sender_id": sender_id,
        "sender_name": sender_name,
        "conversation_id": scope.conversation_id,
        "is_draft": True,
    })
    fm.id = FlowMessage.allocate_id(fm.model_dump())
    fm_typeid = TypeId(type=BuiltinEntityType.FLOW_MESSAGE.value, id=fm.id)
    fm.attachment = [
        Attachment(attachment_type=AttachmentType.TYPE_ID, data=str(t))
        for t in [*scope.draft_context, fm_typeid]
    ]
    return await fm.save(someone_typeid)


async def _create_run(
    *,
    scope: HeadlessRunScope,
    process: AgenticProcess,
    prompt_text: str,
    someone_typeid: str,
) -> Run:
    """Open a new Run row in RUNNING state.

    One Run per Approve & Execute. The drawer queries Runs (not processes)
    so each turn surfaces as its own row even though the underlying
    AgenticProcess is reused for Claude session continuity.
    """
    run = Run.model_validate({
        "target_vfs_path": str(scope.target_typeid),
        "process_id": process.id,
        "prompt_text": prompt_text,
        "status": RunStatus.RUNNING.value,
        "started_at": datetime.now(UTC).isoformat(),
    })
    return await run.save(someone_typeid)


async def _finalize_run(
    *,
    run: Run,
    errored: bool,
    draft_fm_id: Optional[str],
    someone_typeid: str,
) -> None:
    """Land the Run in a terminal status. Best-effort — never raises.

    Fires an explicit ``notify_updated`` after save: ``save()``'s built-in
    UPDATE notification doesn't always reach the entity-event channel that
    ``useEntitiesQuery`` subscribes to (same reason ``materialize_flow_message``
    re-fetches and notifies after its conversation update). Without this the
    second run's spinner stays running until something else triggers a refetch.
    """
    try:
        run.status = (RunStatus.FAILED if errored else RunStatus.STOPPED).value
        run.ended_at = datetime.now(UTC).isoformat()
        if draft_fm_id:
            run.draft_flow_message_id = draft_fm_id
        await run.save(someone_typeid)
        await run.notify_updated()
    except Exception:
        logger.debug("[run] finalize save failed", exc_info=True)


async def _run_turn_and_capture(
    *,
    process: AgenticProcess,
    prompt_text: str,
    scope: HeadlessRunScope,
    run: Run,
    sender_id: Optional[str],
    sender_name: str,
    someone_typeid: str,
) -> None:
    """Drive ClaudeCLIStreamWorker headlessly, capturing assistant text into a draft FlowMessage.

    Scope-agnostic: the worker plumbing (Claude session-id resolution, fork
    bookkeeping, drop-stale-shell, FlowData streaming, status transitions) is
    the same for every entity that anchors a run; only the draft target
    differs, and that's hidden behind ``_save_draft_flow_message(scope=...)``.
    """
    from flow_sdk.builtin.agentic_process.agentic_process import _PROMPT_WORKERS

    cli_cfg = process.cli_config or {}
    # First-turn fork detection. When the process was created via
    # ``AgenticProcess.fork()`` (Scenario C pre-fork), cli_config carries
    # ``fork_session_id`` but the fork's own JSONL doesn't exist on disk yet
    # (the PTY launched claude but no turn has happened, so claude allocated
    # only the session-env directory). Plain ``--resume <fork_sid>`` would
    # fail with "No conversation found". Mirror driver.run_print_turn's
    # logic: when fork_session_id is set, build the context to issue
    # ``--resume <parent> --fork-session --session-id <fork>`` so claude
    # materializes the fork's transcript on this very turn.
    fork_source = cli_cfg.get("fork_session_id")
    transcript = process.driver.transcript_path(process)
    transcript_exists = transcript is not None and transcript.exists()
    is_resume = bool(cli_cfg.get("resume")) or transcript_exists
    if fork_source and not transcript_exists:
        # First turn against a fresh fork — issue the actual fork incantation.
        resume_sid = fork_source
        new_sid = process.session_id
        fork_session = True
    elif is_resume and process.session_id:
        # Subsequent turn or non-fork resume — plain --resume <sid>.
        resume_sid = process.session_id
        new_sid = None
        fork_session = False
    else:
        resume_sid = None
        new_sid = process.session_id
        fork_session = False
    context = AgenticContext(
        workdir=process.workdir,
        env_vars=dict(cli_cfg.get("env_vars") or {}),
        model=cli_cfg.get("model") or "sonnet",
        permission_mode=cli_cfg.get("permission_mode", "bypassPermissions"),
        resume_session_id=resume_sid,
        session_id=new_sid,
        fork_session=fork_session,
    )

    # Drop any attached interactive PTY before launching the print-mode
    # subprocess. Two claude processes on the same session id race on the
    # JSONL: the interactive one doesn't tail the file, so turns appended
    # here are invisible to the open xterm and the user is stuck looking at
    # a stale transcript until they reopen. Killing the shell now means the
    # next time the user clicks "Open Shared Terminal" / the Runs row, a
    # fresh ``claude --resume`` reads the up-to-date JSONL and renders the
    # new turn. (Not destructive — only the PTY view goes; the entity, the
    # session_id, and the transcript file are untouched.)
    if process.shell_id:
        try:
            from flow_sdk.builtin.shell import Shell
            existing_shell = await Shell.get_by_id(process.shell_id)
            if existing_shell is not None:
                await process._drop_stale_shell(
                    existing_shell,
                    reason=f"{scope.log_label}: avoid stale xterm vs. print-mode JSONL writer",
                )
        except Exception:
            logger.debug("[%s] drop-shell failed", scope.log_label, exc_info=True)

    cli_cfg_with_prompt = dict(process.cli_config or {})
    cli_cfg_with_prompt["last_prompt"] = prompt_text
    process.cli_config = cli_cfg_with_prompt
    if process.status != ProcessStatus.RUNNING.value:
        process.status = ProcessStatus.RUNNING.value
    try:
        await process.save(someone_typeid)
    except Exception:
        logger.debug("[%s] lifecycle save failed", scope.log_label, exc_info=True)

    worker = ClaudeCLIStreamWorker()
    _PROMPT_WORKERS[process.id] = worker
    captured: list = []
    errored = False
    try:
        async for fd in worker.execute(prompt=prompt_text, context=context):
            captured.append(fd)
            sid = worker.get_session_id()
            if sid and process.session_id != sid:
                process.session_id = sid
                try:
                    await process.save(someone_typeid)
                except Exception:
                    logger.debug("[%s] session_id save failed", scope.log_label, exc_info=True)
            try:
                await process.emit_flow_data(fd.model_dump())
            except Exception:
                logger.debug("[%s] emit_flow_data failed", scope.log_label, exc_info=True)
    except Exception:
        errored = True
        logger.exception("[%s] worker error", scope.log_label)
    finally:
        _PROMPT_WORKERS.pop(process.id, None)
        # Headless turn is over. Land the process in a terminal status and
        # rewrite cli_config so opening it in a PTY later resumes the saved
        # session interactively, instead of re-running the print-mode
        # invocation (which fails with "session already in use").
        process.status = ProcessStatus.FAILED.value if errored else ProcessStatus.STOPPED.value
        cli_cfg_next = dict(process.cli_config or {})
        cli_cfg_next.pop("print_mode", None)
        cli_cfg_next.pop("output_format", None)
        if process.session_id:
            cli_cfg_next["resume"] = True
        # First-turn fork has now materialized the JSONL (or failed). Either
        # way, the fork is no longer a "fork" — subsequent runs should
        # plain --resume against the now-existing transcript. Leaving
        # fork_session_id in place would cause every turn to re-fork from
        # the parent, throwing away the fork's accumulated history.
        if not errored and fork_source:
            cli_cfg_next.pop("fork_session_id", None)
        process.cli_config = cli_cfg_next
        try:
            await process.save(someone_typeid)
        except Exception:
            logger.debug("[%s] terminal save failed", scope.log_label, exc_info=True)
        try:
            await process.notify_updated()
        except Exception:
            logger.debug("[%s] terminal notify_updated failed", scope.log_label, exc_info=True)

    if errored:
        await _finalize_run(run=run, errored=True, draft_fm_id=None, someone_typeid=someone_typeid)
        return

    text = _extract_assistant_text(captured)
    if not text:
        # Claude's exit reason and any error message live in the result/status
        # events; surface them so we can distinguish "session not found" from
        # "rate limited" from "permissions error".
        details = []
        for fd in captured:
            attrs = getattr(fd, "attributes", {}) or {}
            kind = attrs.get("element-type")
            if kind in ("result", "status"):
                details.append({
                    "kind": kind,
                    "subtype": attrs.get("subtype"),
                    "outcome": attrs.get("outcome"),
                    "value": getattr(fd, "flow_value", None),
                })
        logger.warning(
            "[%s] empty assistant output for target=%s process=%s "
            "captured=%d session_id=%s resume=%s details=%s",
            scope.log_label, scope.target_typeid, process.id, len(captured),
            process.session_id, is_resume, details,
        )
        await _finalize_run(run=run, errored=False, draft_fm_id=None, someone_typeid=someone_typeid)
        return
    draft = await _save_draft_flow_message(
        scope=scope,
        text=text,
        sender_id=sender_id,
        sender_name=sender_name,
        someone_typeid=someone_typeid,
    )
    await _finalize_run(
        run=run,
        errored=False,
        draft_fm_id=draft.id if draft else None,
        someone_typeid=someone_typeid,
    )


async def run_scope(scope: HeadlessRunScope, prompt_text: str, someone_typeid: str) -> ApiResponse:
    """Public orchestrator: spawn/reuse a process for ``scope``, fire the
    headless turn in the background, return ``process_id`` to the caller.

    Per-entity action handlers build a scope and call this. Returns immediately
    with ``{process_id}``; the run continues in the background and surfaces in
    the UI via the standard process entity-update channels (Runs drawer) and
    via the draft FlowMessage entity query (ConversationView).
    """
    if not prompt_text:
        return ApiFailResponse(message="prompt is required")
    if not scope.workdir:
        return ApiFailResponse(
            message=f"{scope.target_typeid.type} has no project mapped — map it to a local project first"
        )

    sender_id, sender_name = await User.local_sender_identity()

    process = await _resolve_or_spawn_process(scope, someone_typeid)
    run = await _create_run(
        scope=scope, process=process, prompt_text=prompt_text, someone_typeid=someone_typeid,
    )

    asyncio.create_task(
        _run_turn_and_capture(
            process=process,
            prompt_text=prompt_text,
            scope=scope,
            run=run,
            sender_id=sender_id,
            sender_name=sender_name,
            someone_typeid=someone_typeid,
        ),
        name=f"{scope.log_label}-{scope.target_typeid.id[:8] if scope.target_typeid.id else '?'}",
    )
    return ApiSuccessResponse(data={"process_id": process.id, "run_id": run.id})
