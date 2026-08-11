"""ScanActionsMixin — resource scanning & agentic process actions for ComputeNode."""

from __future__ import annotations

import logging

from flow_sdk.builtin.faas import scan_indexer
from flow_sdk.builtin.faas.project_list import (
    list_projects_from_indexer as _list_projects_from_indexer,
)
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse


def _resolve_session_record(session_id: str, hint: str | None = None):
    """Locate a session record on disk by id, auto-discovering worker_type.

    With ``hint`` set to ``"claude"``, ``"codex"``, or ``"copilot"``, only
    the matching backend is probed. Without a hint, Claude is tried first,
    then Codex, then Copilot.

    Returns ``(record, worker_type)`` on hit; ``(None, None)`` on miss.
    Worker_type is the canonical query/api spelling.
    """
    if hint not in (None, "claude", "codex", "copilot"):
        return None, None

    if hint not in ("codex", "copilot"):
        from flow_sdk.fs_store.indexer.functions.claude_sessions import get_claude_session

        rec = get_claude_session(session_id)
        if rec is not None:
            return rec, "claude"

    if hint not in ("claude", "copilot"):
        from flow_sdk.fs_store.indexer.functions.codex_sessions import get_codex_session

        rec = get_codex_session(session_id)
        if rec is not None:
            return rec, "codex"

    if hint not in ("claude", "codex"):
        from types import SimpleNamespace

        from flow_sdk.builtin.agentic_process.cli_drivers.copilot.session_history import (
            find_copilot_session_jsonl,
            read_copilot_session_meta,
        )

        path = find_copilot_session_jsonl(session_id)
        if path is not None:
            meta = read_copilot_session_meta(path)
            return SimpleNamespace(
                cwd=meta.get("cwd"),
                name=session_id,
                jsonl_path=str(path),
                source_file=str(path),
            ), "copilot"

    return None, None


# ─────────────────────────────────────────────────────────────────────────────
# launch pre-flight — a "needs a human" verdict is a 4xx, not a 500
# ─────────────────────────────────────────────────────────────────────────────


def _start_failure_response(reason, worker_type: str, fallback: ApiFailResponse) -> ApiFailResponse:
    """Classify a spawn failure that got past the pre-flight.

    The pre-flight can still lose a race — a CLI deleted between the check and
    the spawn. ``LaunchError.classify`` already recognises ``WorkerSpawnError``
    and the "no … installation discovered" text, so a config verdict answers
    4xx here instead of inheriting the 500 default (which ``response.py`` would
    otherwise stamp on — the FLOWPAD-1971 symptom). Anything transient keeps the
    caller's original response.
    """
    from flow_sdk.builtin.agentic_process.launch_health import LaunchError, LaunchHealth

    exc = reason if isinstance(reason, BaseException) else RuntimeError(str(reason))
    verdict = LaunchError.classify(exc, worker_type)
    if verdict.health is not LaunchHealth.CONFIG_ERROR:
        return fallback
    return ApiFailResponse(
        message=f"{worker_type} is not available on this machine.",
        status_code=400,
    )


class ScanActionsMixin:
    async def _scan_scoped_roots(self):
        """Full-coverage (user + all projects) indexer roots for resource scans."""
        from flow_sdk.fs_store.operations.all_projects import get_all_scope_filter

        # Background resource scan — gate protected folders rather than prompting.
        return await self._resolve_scoped_roots(await get_all_scope_filter(create_missing=False), foreground=False)

    async def _scan_resources(self) -> ApiResponse:
        """Scan specific resource type with optional time window filtering.

        Ported from FlowPad: flowpad/hub/builtin/faas/compute_node.py
        Desktop stub: returns empty results since system_profile scripts
        are not available in desktop mode.

        Query params:
            type: Resource type (hook, mcp_server, session, etc.)
            time_start: ISO timestamp for window start
            time_end: ISO timestamp for window end
            parent_id: Parent resource ID for child resources
            limit: Max items (default 100)
            offset: Pagination offset (default 0)

        Returns:
            ApiResponse with items, scanned_window, total_count, has_more, resource_type
        """
        request_info = get_current_request_info()
        if not request_info or not request_info.request:
            return ApiFailResponse(message="No request info available")

        resource_type = request_info.get_param("type")
        if not resource_type:
            return ApiFailResponse(message="type parameter is required")

        limit_str = request_info.get_param("limit")
        offset_str = request_info.get_param("offset")
        limit = int(limit_str) if limit_str else 100
        offset = int(offset_str) if offset_str else 0

        time_start = request_info.get_param("time_start")
        time_end = request_info.get_param("time_end")
        parent_id = request_info.get_param("parent_id")
        time_window = None
        if time_start or time_end:
            time_window = {"start": time_start, "end": time_end}

        try:
            scoped_roots = await self._scan_scoped_roots()
            result = await scan_indexer.scan_resources_from_indexer(
                resource_type,
                scoped_roots,
                time_window=time_window,
                parent_id=parent_id,
                limit=limit,
                offset=offset,
            )
            return ApiSuccessResponse(data=result)
        except Exception as e:
            logging.exception(f"scan-resources failed: {e}")
            return ApiFailResponse(message=str(e))

    async def _scan_get_resource_summary(self) -> ApiResponse:
        """Get quick counts per resource type without full scan.

        Ported from FlowPad: flowpad/hub/builtin/faas/compute_node.py
        Desktop stub: returns empty summary.

        Returns:
            ApiResponse with dict mapping resource_type -> count
        """
        try:
            scoped_roots = await self._scan_scoped_roots()
            result = await scan_indexer.get_resource_summary_from_indexer(scoped_roots)
            return ApiSuccessResponse(data=result)
        except Exception as e:
            logging.exception(f"get-resource-summary failed: {e}")
            return ApiFailResponse(message=str(e))

    async def _scan_item(self) -> ApiResponse:
        """Scan a specific item type (costOverview, sessions, projects, etc).

        Ported from FlowPad: flowpad/hub/builtin/faas/compute_node.py
        Desktop stub: returns empty result.

        Query params:
            type: Item type to scan (e.g., costOverview, sessions, projects)
            limit: Max sessions to analyze (default 100)

        Returns:
            ApiResponse with the scanned item data
        """
        request_info = get_current_request_info()
        if not request_info or not request_info.request:
            return ApiFailResponse(message="No request info available")

        item_type = request_info.get_param("type")
        if not item_type:
            return ApiFailResponse(message="type parameter is required")

        # Cost / context moved to dedicated analytics actions
        # (get-cost-overview / get-claude-context).
        # scan-item now only serves a flat resource-type list (e.g. skills).
        _ITEM_TO_RESOURCE = {
            "skills": "skill",
            "agents": "subagent",
            "commands": "command",
            "hooks": "hook",
            "mcpServers": "mcp_server",
            "plugins": "plugin",
            "sessions": "claude_session",
        }
        resource = _ITEM_TO_RESOURCE.get(item_type)
        if resource is None:
            return ApiSuccessResponse(data=None)

        try:
            scoped_roots = await self._scan_scoped_roots()
            res = await scan_indexer.scan_resources_from_indexer(resource, scoped_roots, limit=0)
            return ApiSuccessResponse(data=res.get("items", []))
        except Exception as e:
            logging.exception(f"scan-item failed: {e}")
            return ApiFailResponse(message=str(e))

    async def _scan_clear_skill_usage(self) -> ApiResponse:
        """Clear all skill usage counters from ~/.claude.json."""
        try:
            from flow_sdk.fs_store.operations.claude_settings import clear_skill_usage

            cleared = clear_skill_usage()
            return ApiSuccessResponse(data={"cleared": cleared})
        except Exception as e:
            logging.exception(f"clear-skill-usage failed: {e}")
            return ApiFailResponse(message=str(e))

    async def _scan_clear_cli_log(self) -> ApiResponse:
        """Clear all CLI invocation log entries."""
        try:
            from flow_sdk.cli.cli_log import clear_log

            count = clear_log()
            return ApiSuccessResponse(data={"cleared": count})
        except Exception as e:
            logging.exception(f"clear-cli-log failed: {e}")
            return ApiFailResponse(message=str(e))

    async def _scan_list_projects(self) -> ApiResponse:
        """List projects from the indexed Claude/Codex project records.

        Returns:
            ApiResponse with projects list and total_count
        """
        try:
            result = await _list_projects_from_indexer()
            return ApiSuccessResponse(data=result)
        except Exception as e:
            logging.exception(f"list-projects failed: {e}")
            return ApiFailResponse(message=str(e))

    async def _scan_project(self) -> ApiResponse:
        """Scan all resources for a specific project.

        Ported from FlowPad: flowpad/hub/builtin/faas/compute_node.py
        Desktop stub: returns empty project scan result.

        Query params:
            project: Project encoded name (required)
            limit: Max sessions (default 100)

        Returns:
            ApiResponse with project scan data
        """
        request_info = get_current_request_info()
        if not request_info or not request_info.request:
            return ApiFailResponse(message="No request info available")

        project = request_info.get_param("project")
        if not project:
            return ApiFailResponse(message="project parameter is required")

        limit_str = request_info.get_param("limit")
        limit = int(limit_str) if limit_str else 100
        sessions_str = request_info.get_param("sessions")
        include_sessions = sessions_str != "false"

        try:
            result = await scan_indexer.scan_project_from_indexer(
                project_encoded_name=project,
                session_limit=limit,
                include_sessions=include_sessions,
            )
            return ApiSuccessResponse(data=result)
        except Exception as e:
            logging.exception(f"scan-project failed: {e}")
            return ApiFailResponse(message=str(e))

    async def _scan_create_process(self) -> ApiResponse:
        """Create a new idle AgenticProcess on this ComputeNode.

        POST body: { context, result, visible } (same shape as CreateProcessRequest)

        Returns:
            AgenticProcess entity data
        """
        from flow_sdk.builtin.agentic_process import AgenticProcess
        from flow_sdk.builtin.agentic_process.cli_drivers.claude import ClaudeAgentOptions
        from flow_sdk.builtin.agentic_process.cli_drivers.codex import CodexAgentOptions
        from flow_sdk.builtin.agentic_process.cli_drivers.copilot import CopilotAgentOptions
        from flow_sdk.flowpad_types.enums import ProcessKind, WorkerType

        try:
            request_info = get_current_request_info()
            owner = request_info.someone_typeid if request_info else None

            body = {}
            if request_info:
                body = await request_info.get_post_data() or {}
            if not isinstance(body, dict):
                body = {}

            context_raw = body.get("context", {})
            if not isinstance(context_raw, dict):
                context_raw = {}

            visible = bool(body.get("visible", False))
            # Transport intent for the new session: True → interactive PTY
            # (default), False → headless JSON-stream (no PTY/xterm). The UI passes
            # False for a Standard chat tab; omitted → True so every existing
            # caller (tests, automations) keeps today's PTY behaviour.
            pty_mode = bool(body.get("pty_mode", True))
            # Optional first prompt to seed onto the queue BEFORE the visible
            # auto-start below, so the worker boots with it as its launch arg
            # (``_perform_open`` pops the head). Enqueuing here — pre-start —
            # is what makes launch-via-queue deterministic; a post-start enqueue
            # would race the boot and fall back to the stdin path.
            launch_prompt = body.get("launch_prompt")
            result_data = body.get("result")

            context_data = dict(context_raw)
            workdir = context_data.pop("workdir", None)
            project_id = context_data.pop("project_id", None)
            # VFS path of the attached entity (trigger, markdown, …); stored on the process for the runs drawer / chat panel queries.
            target_typeid_str = context_data.pop("target_typeid_str", None)
            # Lift `process_type` out of `context_data` so it lands on the
            # top-level field declared in the AgenticProcess schema. The
            # `useProcessesForTarget` filter on the chat-panel queries
            # `match: { process_type: 'chat' }` against the top-level field;
            # leaving it nested in `context_data.process_type` makes the chat
            # toolbar's history dropdown show empty even when sessions exist.
            process_type_raw = context_data.pop("process_type", None)
            process_type: ProcessKind | None = None
            if process_type_raw:
                try:
                    process_type = ProcessKind(process_type_raw)
                except (ValueError, TypeError):
                    process_type = None

            fork_session = bool(context_data.pop("fork_session", False))
            resume_session_id = context_data.pop("resume_session_id", None)
            additional_dirs: list[str] = list(context_data.pop("additional_dirs", None) or [])
            # Per-process Flowpad Assistant mount. Set BEFORE the auto-start
            # below so the driver's --add-dir set includes the assistant skills
            # on first launch — lets a worker run in the conversation's own
            # project while still discovering the assistant (no cwd switch to
            # the @flowpad_assistant system project). None inherits the global
            # ServiceConfig default.
            load_flowpad_assistant = context_data.pop("load_flowpad_assistant", None)
            # Provenance links (string TypeIds) to stamp onto the new process's
            # shared_context_entities before save — e.g. the anchor FlowMessage
            # a conversation session is started from.
            shared_context_entities_raw = context_data.pop("shared_context_entities", None) or []

            # Worker selection — accept ``worker_type`` from the AgenticContext
            # so the UI can launch alternate CLI tabs from the same opener flow
            # that spawns Claude. An unknown value is a hard error: silently
            # substituting Claude launches the wrong worker with no signal
            # (e.g. a UI that knows 'copilot' talking to a backend that
            # doesn't), which is far more confusing than a failed request.
            worker_type_raw = context_data.pop("worker_type", None)
            if worker_type_raw is None:
                from flow_sdk.core.capabilities.registry import resolve_default_worker_type

                worker_type_raw = await resolve_default_worker_type()
            try:
                worker_type = WorkerType(worker_type_raw)
            except ValueError:
                # A client naming a worker this backend doesn't have is a client
                # error; without an explicit status_code it would answer 500.
                return ApiFailResponse(message=f"Unknown worker_type: {worker_type_raw!r}", status_code=400)

            # Pre-flight the harness BEFORE anything is persisted, so a provider
            # the machine can't run is refused with a structured 400 instead of
            # failing deep in the spawn (which reached HTTP as a bare 500) and
            # leaving a FAILED row behind for every attempt.
            #
            # ``is_installed`` rather than ``ensure_launchable``: the latter also
            # runs the login probe, which shells out to the vendor CLI uncached,
            # and no subprocess belongs on a per-create request path. This is a
            # lookup in the discovery dict — the same SSOT ``worker_path_env``
            # reads at spawn, so it can never turn away a launch that would have
            # worked. A logged-out harness still fails at launch, where it is
            # latched and reported as it is today.
            #
            # Deliberately gates headless creates too. A standard-mode session
            # with a missing CLI used to be born fine and only break on its first
            # prompt, where the failure rides a 200 stream and no status code can
            # reach the user.
            if not await AgenticProcess.is_installed(worker_type.value):
                logging.info(f"ComputeNode {self.id} createProcess refused: {worker_type.value} is not installed")
                return ApiFailResponse(
                    message=f"{worker_type.value} is not installed on this machine.",
                    status_code=400,
                )

            model = context_data.pop("model", None) or None
            permission_mode = context_data.pop("permission_mode", "bypassPermissions")
            agents_json = context_data.pop("agents_json", None)
            env_vars_raw = context_data.pop("env_vars", None)
            env_vars = dict(env_vars_raw) if isinstance(env_vars_raw, dict) else {}
            output_format = context_data.pop("output_format", None)
            # A ``stream-json`` process is headless by contract (print-mode, no
            # PTY — see ts_sdk agentic-context.ts). ``pty_mode`` defaults True
            # when omitted, so a caller that requests stream-json output but
            # forgets ``pty_mode=False`` would be born PTY-transport and hang:
            # its first queued prompt never drains (``_queue_ready`` withholds
            # cold-start from PTY processes, which expect a dock loader that an
            # invisible worker never gets). Enforce the contract here so no
            # headless caller can strand its worker.
            if output_format == "stream-json":
                pty_mode = False
            if worker_type == WorkerType.CODEX:
                cli_opts = CodexAgentOptions(
                    model=model,
                    permission_mode=permission_mode,
                    env_vars=env_vars,
                )
                # Codex reads agent specs at runtime from the process entity
                # (``CodexDriver.cli_options`` mirrors them onto ``skill_names``),
                # and doesn't expose ``output_format``/``chrome``/``debug``/
                # ``worktree`` flags — drop them from the unrecognized-fields
                # carry-over.
                context_data.pop("chrome", None)
                context_data.pop("debug", None)
                context_data.pop("worktree", None)
            elif worker_type == WorkerType.COPILOT:
                cli_opts = CopilotAgentOptions(
                    model=model,
                    permission_mode=permission_mode,
                    effort=context_data.pop("effort", None),
                    env_vars=env_vars,
                )
                context_data.pop("chrome", None)
                context_data.pop("debug", None)
                context_data.pop("worktree", None)
            else:
                cli_opts = ClaudeAgentOptions(
                    model=model,
                    permission_mode=permission_mode,
                    agents_json=agents_json,
                    env_vars=env_vars,
                    output_format=output_format,
                    chrome=bool(context_data.pop("chrome", False)),
                    debug=bool(context_data.pop("debug", True)),
                    worktree=bool(context_data.pop("worktree", False)),
                )

            if fork_session and resume_session_id and worker_type not in (WorkerType.CODEX, WorkerType.COPILOT):
                # Codex/Copilot have no fork concept — fall through to plain resume below.
                cli_opts.resume = True
                cli_opts.fork_session_id = resume_session_id
            elif resume_session_id:
                cli_opts.resume = True

            # Resolve project_id from workdir prefix-match when the caller didn't
            # supply one. Otherwise AgenticProcess.get_project() falls back to
            # DB ancestry which returns the user's canonical project — not the
            # UI-active one — causing a project/workdir mismatch on the entity.
            if workdir and not project_id:
                try:
                    from flow_sdk.builtin.project import Project

                    projects = await Project.get_all()
                    best, best_len = None, 0
                    for p in projects:
                        mp = getattr(p, "fs_storage_mount_path", None)
                        if mp and workdir.startswith(str(mp)) and len(str(mp)) > best_len:
                            best, best_len = p, len(str(mp))
                    if best:
                        project_id = best.id
                except Exception:
                    pass

            # Default workdir to the project's mount path when only project_id
            # was supplied. Worktree callers (and any flow that needs a workdir
            # distinct from the project root) keep working because they pass
            # an explicit workdir, which we don't overwrite.
            if project_id and not workdir:
                try:
                    from flow_sdk.builtin.project import Project

                    proj = await Project.get_by_id(project_id)
                    if proj is not None and proj.fs_storage_mount_path:
                        workdir = str(proj.fs_storage_mount_path)
                except Exception:
                    pass

            process = AgenticProcess(
                worker_type=worker_type.value,
                instruction_content="",
                cli_config=cli_opts.to_json(),
                context_data=context_data,
                workdir=workdir,
                visible=visible,
                pty_mode=pty_mode,
                additional_dirs=additional_dirs,
                project_id=project_id or None,
                target_typeid_str=target_typeid_str or None,
                process_type=process_type,
                load_flowpad_assistant=load_flowpad_assistant,
            )
            if resume_session_id and not fork_session:
                process.session_id = resume_session_id
            # Stamp provenance links before save so they ride the same write.
            # Invalid / unparseable typeids are skipped — a bad provenance hint
            # must never block a launch.
            if shared_context_entities_raw:
                from flow_sdk.api.api_types.type_id import TypeId as _TypeId

                tids = []
                for raw in shared_context_entities_raw:
                    try:
                        tids.append(raw if isinstance(raw, _TypeId) else _TypeId(str(raw)))
                    except Exception:
                        logging.debug(f"createProcess: skipping unparseable shared_context_entity {raw!r}")
                if tids:
                    process.add_shared_context_entities(*tids)
            await process.save(owner)

            # ANALYSIS kind: the new process is a child of the entity it
            # analyzes (target_typeid_str) and each joins the other's private
            # context. Best-effort — a missing/surface-scoped target must
            # never block the launch.
            if process_type == ProcessKind.ANALYSIS:
                try:
                    await process.pair_analysis_context(owner)
                except Exception:
                    logging.exception(f"createProcess: analysis pairing failed for {process.id}")

            if result_data and isinstance(result_data, dict):
                try:
                    from flow_sdk.builtin.process_result import ProcessResult

                    result_uname = result_data.get("uname")
                    existing_result = None
                    if result_uname:
                        existing_result = await ProcessResult.get_by_uname(result_uname)

                    result_type = result_data.get("result_type") or result_data.get("resultType")
                    source_session_id = result_data.get("source_session_id") or result_data.get("sourceSessionId")

                    if existing_result:
                        existing_result.agentic_process_id = process.id
                        existing_result.status = "running"
                        existing_result.result_type = result_type
                        existing_result.source_session_id = source_session_id
                        await existing_result.save(owner)
                    else:
                        process_result = ProcessResult(
                            uname=result_uname,
                            agentic_process_id=process.id,
                            status="running",
                            result_type=result_type,
                            source_session_id=source_session_id,
                        )
                        await process_result.save(owner)
                except ImportError:
                    logging.debug("ProcessResult entity not available, skipping result creation")

            logging.info(f"ComputeNode {self.id} created AgenticProcess {process.id}")

            # Seed the launch prompt onto the queue BEFORE any auto-start. Use
            # the PromptQueue directly (not the enqueue *action*) so we don't
            # schedule a competing drain — the start_pty below drains the head
            # as the launch instruction.
            if launch_prompt and str(launch_prompt).strip():
                try:
                    process.queue.enqueue(str(launch_prompt), source="ui")
                except Exception:
                    logging.exception(
                        f"ComputeNode {self.id} createProcess: failed to seed launch prompt for {process.id}"
                    )

            # Visible (PTY) processes spawn the linked Shell here so the
            # frontend gets a fully-attached row in one round-trip; otherwise
            # the tab strip races a Phase-B refresh and ends up empty.
            #
            # Headless (visible=False) processes manage their lifecycle
            # per-turn via ``headless_prompt`` — pre-spawning a PTY here would
            # claim a session_id without ever writing a JSONL, leaving the
            # next ``/prompt`` to land on a stale session and emit nothing.
            if visible:
                try:
                    start_resp = await process.start_pty(visible=visible)
                except Exception as start_err:
                    logging.exception(f"ComputeNode {self.id} createProcess start error for {process.id}: {start_err}")
                    return _start_failure_response(
                        start_err,
                        worker_type.value,
                        ApiFailResponse(message=f"Process {process.id} created but failed to start: {start_err}"),
                    )

                if isinstance(start_resp, ApiFailResponse):
                    # ``_perform_open`` returns its failure with no status_code
                    # (⇒ 500). Classify the latched reason so a harness that
                    # vanished between the pre-flight and the spawn still reads
                    # as a client error the UI can act on.
                    return _start_failure_response(start_resp.message or "", worker_type.value, start_resp)
            elif launch_prompt and str(launch_prompt).strip():
                # Headless launch (visible=False) with a seeded first prompt: PTY
                # drains the queue head via ``start_pty`` above, but headless has no
                # PTY — so kick the drain explicitly. Fire-and-forget (same wrapper
                # ``_enqueue_action`` uses) so the createProcess response never
                # blocks on the turn; it also logs any drain-task exception.
                process._schedule_queue_drain("enqueue")

            data = process.model_dump(mode="json")
            # ``pty_pid`` is not an AgenticProcess field, but the legacy
            # identity-only response exposed it. Keep the key additively while
            # returning the full authoritative entity projection.
            data.setdefault("pty_pid", getattr(process, "pty_pid", None))
            return ApiSuccessResponse(data=data)

        except Exception as e:
            logging.exception(f"ComputeNode {self.id} createProcess error: {e}")
            return ApiFailResponse(message=str(e))

    async def _scan_upsert_session_process(self) -> ApiResponse:
        """Thin POST wrapper — reads body params and delegates to the shared impl.

        Idempotent on ``session_id``. Frontend callers are expected to use
        ``terminals/get_by_worker_id/<id>`` (which auto-discovers worker_type);
        this POST endpoint remains for backend-internal callers and tests.

        POST body (camelCase):
            sessionId:  str           — session/thread ID
            workdir:    str | None    — working directory
            projectId:  str | None    — project ID for context
            workerType: str | None    — "claude" (default) or "codex"

        Returns: ApiSuccessResponse with the full AgenticProcess entity dict.
        """
        request_info = get_current_request_info()
        if not request_info or not request_info.request:
            return ApiFailResponse(message="No request info available")

        body = await request_info.get_post_data()
        if not isinstance(body, dict):
            return ApiFailResponse(message="Invalid request body (expected JSON object)")

        session_id = body.get("sessionId")
        if not session_id:
            return ApiFailResponse(message="sessionId is required")

        return await self._upsert_session_process_impl(
            session_id=session_id,
            workdir=body.get("workdir"),
            project_id=body.get("projectId"),
            worker_type_raw=(body.get("workerType") or "claude").lower(),
        )

    async def _upsert_session_process_impl(
        self,
        session_id: str,
        workdir: str | None,
        project_id: str | None,
        worker_type_raw: str,
        *,
        session_rec=None,
    ) -> ApiResponse:
        """Find or create an AgenticProcess for ``session_id``.

        Resolves session record on disk, heals an existing
        AgenticProcess if one matches ``session_id``, otherwise creates a new
        one and atomically spawns its Shell + PTY. Returns the full entity
        dict so callers can hydrate the frontend cache without a follow-up
        ``getById``.

        ``session_rec`` may be passed pre-resolved (e.g. from the worker-id
        sub-path that already located it) to skip a redundant disk scan.
        """
        from flow_sdk.builtin.agentic_process import AgenticProcess
        from flow_sdk.flowpad_types.enums import WorkerType

        request_info = get_current_request_info()

        try:
            is_codex = worker_type_raw in ("codex",)
            is_copilot = worker_type_raw in ("copilot",)
            cli_factory_key = "copilot" if is_copilot else ("codex" if is_codex else "claude")
            wt_enum = WorkerType.COPILOT if is_copilot else (WorkerType.CODEX if is_codex else WorkerType.CLAUDE_CODE)

            # Resolve workdir + project_id from the session record.
            # Transcript cwd is the authoritative restore location; project_id is
            # derived from it so worktrees / nested checkouts don't collapse into
            # the active dock project.
            session_name: str | None = None
            try:
                from flow_sdk.builtin.project import Project

                if session_rec is None:
                    session_rec, _ = _resolve_session_record(
                        session_id,
                        hint="copilot" if is_copilot else ("codex" if is_codex else "claude"),
                    )

                if session_rec:
                    rec_cwd = getattr(session_rec, "cwd", None)
                    if rec_cwd and not workdir:
                        workdir = rec_cwd
                    rec_name = getattr(session_rec, "name", None) or ""
                    if rec_name and rec_name != session_id:
                        session_name = rec_name

                if workdir:
                    project = await Project.recover_by_path(workdir)
                    if project:
                        project_id = project.id
            except Exception:
                logging.debug(
                    "ComputeNode %s upsertSessionProcess session context resolve failed for %s",
                    self.id,
                    session_id,
                    exc_info=True,
                )

            # Try to find existing process by session_id
            process = await AgenticProcess.get_by_session_id(session_id)
            if process:
                changed = False
                context_data = dict(process.context_data or {})
                # Track which fields actually moved so we can mirror exactly
                # those changes into context_data and the linked Shell —
                # honouring the binding freeze on session-bound processes.
                workdir_bound = False
                project_bound = False
                if workdir and process.workdir != workdir:
                    process.workdir = workdir
                    if process.workdir == workdir:
                        workdir_bound = True
                        changed = True
                if project_id and process.project_id != project_id:
                    if process._bind_project_id(project_id):
                        project_bound = True
                        changed = True
                if workdir_bound and context_data.get("workdir") != workdir:
                    context_data["workdir"] = workdir
                if project_bound and context_data.get("project_id") != project_id:
                    context_data["project_id"] = project_id
                if session_name and not process.name:
                    process.name = session_name
                    changed = True
                if changed:
                    process.context_data = context_data
                    await process.save()
                # Only propagate to the linked Shell for fields that actually
                # moved on the process — otherwise the Shell would silently
                # drift away from a frozen process binding.
                if process.shell_id and (workdir_bound or project_bound):
                    try:
                        from flow_sdk.builtin.shell import Shell

                        shell = await Shell.get_by_id(process.shell_id)
                        shell_changed = False
                        if shell and workdir_bound and shell.workdir != workdir:
                            shell.workdir = workdir
                            shell_changed = True
                        if shell and project_bound and shell.project_id != project_id:
                            shell.project_id = project_id
                            shell_changed = True
                        if shell and shell_changed:
                            await shell.save()
                    except Exception:
                        logging.debug(
                            "ComputeNode %s upsertSessionProcess shell context heal failed for %s",
                            self.id,
                            process.id,
                            exc_info=True,
                        )
                # Reattach shell + flip visible so the tab strip surfaces the row.
                start_data = None
                if not process.shell_id or not process.visible:
                    try:
                        start_resp = await process.start_pty(visible=True)
                    except Exception as start_err:
                        logging.exception(
                            f"ComputeNode {self.id} upsertSessionProcess heal-start error for {process.id}: {start_err}"
                        )
                        return ApiFailResponse(message=f"Process {process.id} found but failed to start: {start_err}")
                    if isinstance(start_resp, ApiFailResponse):
                        return start_resp
                    start_data = getattr(start_resp, "data", None)
                get_by_id = getattr(AgenticProcess, "get_by_id", None)
                if callable(get_by_id):
                    refreshed = await get_by_id(process.id)
                    if refreshed is not None:
                        process = refreshed
                data = process.model_dump(mode="json")
                if isinstance(start_data, dict):
                    for key in ("shell_id", "pty_id", "session_id"):
                        if start_data.get(key) and not data.get(key):
                            data[key] = start_data[key]
                return ApiSuccessResponse(data=data)

            # Create new process directly on this compute node
            owner = request_info.someone_typeid if request_info else None

            # Default workdir to the project's mount path when only project_id
            # was supplied. Worktree callers pass their own workdir and aren't
            # affected. (Rule 2: at create-time the binding is project-rooted
            # unless the caller explicitly overrides.)
            if project_id and not workdir:
                try:
                    from flow_sdk.builtin.project import Project  # noqa: PLC0415

                    proj = await Project.get_by_id(project_id)
                    if proj is not None and proj.fs_storage_mount_path:
                        workdir = str(proj.fs_storage_mount_path)
                except Exception:
                    pass

            # Backend-internal callers may upsert a synthetic session id before
            # any worker transcript exists. There is no authoritative cwd to
            # restore, so bind it to the local project instead of failing the
            # route before the process can be materialized.
            if not workdir and session_rec is None:
                try:
                    from flow_sdk.builtin.project import Project  # noqa: PLC0415

                    local_project = await Project.get_by_uname("local")
                    if local_project is not None and local_project.fs_storage_mount_path:
                        workdir = str(local_project.fs_storage_mount_path)
                        project_id = project_id or local_project.id
                except Exception:
                    pass

            # Defense-in-depth: a resumed session must restore into its
            # original cwd. Creating the process without one would let
            # get_project() bind an arbitrary ancestor project and bake a
            # cwd-mismatched `--resume` into cmd_line — the worker then
            # crash-loops ("No conversation found") under the wrong project.
            # Fail loudly instead of guessing.
            if not workdir:
                return ApiFailResponse(
                    message=(
                        f"Session {session_id} resolved but its working "
                        "directory is unknown — cannot restore it into a project."
                    )
                )

            context_data = {"workdir": workdir}
            if project_id:
                context_data["project_id"] = project_id

            process = AgenticProcess(
                session_id=session_id,
                worker_type=wt_enum,
                use_worker_history=True,
                context_data=context_data,
                project_id=project_id or None,
                workdir=workdir or None,
                visible=True,
                **({"name": session_name} if session_name else {}),
            )
            await process.save(owner=owner)

            logging.info(
                f"ComputeNode {self.id} upserted AgenticProcess {process.id} for "
                f"session {session_id} worker_type={cli_factory_key} (created). "
                f"session_id on saved object={process.session_id}"
            )

            # Set resume flag if transcript exists on disk.
            # Once resume=True is stored we skip this check on subsequent calls.
            if not process.cli_config.get("resume") and session_rec is not None:
                from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
                    factory as _cli_factory,
                )

                _cmd = _cli_factory(process.cli_config, worker_type=cli_factory_key)
                _cmd.resume = True
                # Codex/Copilot resume need the id passed as the cli session_id
                # (Claude already reads it from process.session_id at args-build time).
                if is_codex or is_copilot:
                    _cmd.session_id = session_id
                process.cli_config = _cmd.to_json()
                # workdir is guaranteed by the create-time guard above — no
                # rec_cwd backfill needed here anymore.
                await process.save()

            # Atomic: spawn the linked Shell + PTY before returning so the
            # frontend gets a fully-attached row in one round-trip — same
            # pattern as `_scan_create_process`. Without this the resumed
            # AgenticProcess has no shell_id, is filtered out of the visible
            # tab strip, and the route loader silently snaps to a fallback.
            try:
                start_resp = await process.start_pty(visible=True)
            except Exception as start_err:
                logging.exception(
                    f"ComputeNode {self.id} upsertSessionProcess start error for {process.id}: {start_err}"
                )
                return ApiFailResponse(message=f"Process {process.id} created but failed to start: {start_err}")

            if isinstance(start_resp, ApiFailResponse):
                return start_resp

            get_by_id = getattr(AgenticProcess, "get_by_id", None)
            if callable(get_by_id):
                refreshed = await get_by_id(process.id)
                if refreshed is not None:
                    process = refreshed
            data = process.model_dump(mode="json")
            start_data = getattr(start_resp, "data", None)
            if isinstance(start_data, dict):
                for key in ("shell_id", "pty_id", "session_id"):
                    if start_data.get(key) and not data.get(key):
                        data[key] = start_data[key]
            return ApiSuccessResponse(data=data)

        except Exception as e:
            logging.exception(f"ComputeNode {self.id} upsertSessionProcess error: {e}")
            return ApiFailResponse(message=str(e))

    async def _scan_get_by_worker_id(self, worker_id: str) -> ApiResponse:
        """Auto-discover worker_type, upsert, return ready-to-use AgenticProcess.

        Single round-trip resolver: caller passes the worker/session/thread id
        and optionally a ``worker_type`` query hint (``claude``, ``codex``, or
        ``copilot``)
        to skip the other backend's disk scan. On hit, delegates to the
        shared upsert impl, forwarding the already-resolved record so the
        impl doesn't re-scan.
        """
        request_info = get_current_request_info()
        hint_raw = (
            (request_info.get_param("worker_type") or request_info.get_param("workerType") or "")
            if request_info
            else ""
        )
        hint = hint_raw.lower() or None
        if hint and hint not in ("claude", "codex", "copilot"):
            return ApiFailResponse(
                message=f"worker_type must be 'claude', 'codex', or 'copilot' (got {hint_raw!r})",
                status_code=400,
            )

        session_rec, worker_type = _resolve_session_record(worker_id, hint=hint)
        if session_rec is None:
            # Disk lookup miss — fall back to an existing AgenticProcess that
            # already carries this session_id. This covers the bookmark flow:
            # the worker assigns a session UUID at startup (we stamp it on the
            # process entity), but the on-disk JSONL only appears after the
            # first turn. Resuming via a bookmark created before the first
            # turn would otherwise 404. Heal directly from the entity DB so
            # the navigation works.
            from flow_sdk.builtin.agentic_process import AgenticProcess  # noqa: PLC0415

            existing = await AgenticProcess.get_by_session_id(worker_id)
            if existing:
                return ApiSuccessResponse(data=existing.model_dump())

            return ApiFailResponse(
                message=f"Session {worker_id} not found in Claude, Codex, or Copilot history",
                status_code=404,
            )

        return await self._upsert_session_process_impl(
            session_id=worker_id,
            workdir=None,
            project_id=None,
            worker_type_raw=worker_type,
            session_rec=session_rec,
        )

    async def _scan_find_session(self) -> ApiResponse:
        """Look up a session by id across Claude, Codex, and Copilot on-disk history.

        Pure read-only resolver: returns the descriptor a caller needs to render
        the transcript and open the session, without creating an AgenticProcess.

        Query params (camelCase or snake_case both accepted via get_param):
            session_id: required — UUID/thread id.
            worker_type: optional — "claude" | "codex" | "copilot" to skip other lookups.

        Returns ApiSuccessResponse with:
            session_id, worker_type, transcript_path, cwd, project_id, session_name.

        Returns ApiFailResponse(status_code=404) when not found in either history.
        """
        from flow_sdk.builtin.project import Project

        request_info = get_current_request_info()
        if not request_info or not request_info.request:
            return ApiFailResponse(message="No request info available")

        session_id = request_info.get_param("session_id") or request_info.get_param("sessionId")
        if not session_id:
            return ApiFailResponse(message="session_id is required", status_code=400)

        worker_hint_raw = request_info.get_param("worker_type") or request_info.get_param("workerType") or ""
        worker_hint = worker_hint_raw.lower() or None
        if worker_hint and worker_hint not in ("claude", "codex", "copilot"):
            return ApiFailResponse(
                message=f"worker_type must be 'claude', 'codex', or 'copilot' (got {worker_hint_raw!r})",
                status_code=400,
            )

        try:
            rec, worker_type = _resolve_session_record(session_id, hint=worker_hint)
            if rec is None:
                return ApiFailResponse(
                    message=f"Session {session_id} not found in Claude, Codex, or Copilot history",
                    status_code=404,
                )

            cwd = getattr(rec, "cwd", None) or None
            rec_name = getattr(rec, "name", None) or None
            session_name = rec_name if rec_name and rec_name != session_id else None
            transcript_path = getattr(rec, "jsonl_path", None) or getattr(rec, "source_file", None) or None

            project_id: str | None = None
            if cwd:
                try:
                    project = await Project.recover_by_path(cwd)
                    if project:
                        project_id = project.id
                except Exception:
                    logging.debug(
                        "ComputeNode %s findSession project recover failed for %s",
                        self.id,
                        session_id,
                        exc_info=True,
                    )

            return ApiSuccessResponse(
                data={
                    "session_id": session_id,
                    "worker_type": worker_type,
                    "transcript_path": str(transcript_path) if transcript_path else None,
                    "cwd": cwd,
                    "project_id": project_id,
                    "session_name": session_name,
                }
            )

        except Exception as e:
            logging.exception(f"ComputeNode {self.id} findSession error: {e}")
            return ApiFailResponse(message=str(e))
