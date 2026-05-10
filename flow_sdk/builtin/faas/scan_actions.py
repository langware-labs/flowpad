"""ScanActionsMixin — resource scanning & agentic process actions for ComputeNode."""
from __future__ import annotations

import asyncio
import logging

from flow_sdk.core.resource_management.scan.system_profile import (
    get_resource_summary as _get_resource_summary,
)
from flow_sdk.core.resource_management.scan.system_profile import (
    list_projects_fast as _list_projects_fast,
)
from flow_sdk.core.resource_management.scan.system_profile import (
    scan_item as _scan_item,
)
from flow_sdk.core.resource_management.scan.system_profile import (
    scan_project as _scan_project,
)
from flow_sdk.core.resource_management.scan.system_profile import (
    scan_resources as _scan_resources,
)
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse


class ScanActionsMixin:
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
            loop = asyncio.get_event_loop()
            result = await loop.run_in_executor(
                None,
                lambda: _scan_resources(
                    resource_type=resource_type,
                    time_window=time_window,
                    parent_id=parent_id,
                    limit=limit,
                    offset=offset,
                ),
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
            loop = asyncio.get_event_loop()
            result = await loop.run_in_executor(None, _get_resource_summary)
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

        limit_str = request_info.get_param("limit")
        limit = int(limit_str) if limit_str else 100
        session_id = request_info.get_param("session_id") or None

        try:
            loop = asyncio.get_event_loop()
            result = await loop.run_in_executor(
                None, lambda: _scan_item(item_type=item_type, limit=limit, session_id=session_id)
            )
            return ApiSuccessResponse(data=result)
        except Exception as e:
            logging.exception(f"scan-item failed: {e}")
            return ApiFailResponse(message=str(e))

    async def _scan_clear_skill_usage(self) -> ApiResponse:
        """Clear all skill usage counters from ~/.claude.json."""
        try:
            from flow_sdk.core.resource_management.scan.system_profile.settings import clear_skill_usage

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
        """Fast project enumeration.

        Ported from FlowPad: flowpad/hub/builtin/faas/compute_node.py
        Desktop stub: returns empty project list.

        Returns:
            ApiResponse with projects list and total_count
        """
        try:
            loop = asyncio.get_event_loop()
            result = await loop.run_in_executor(None, _list_projects_fast)
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
            loop = asyncio.get_event_loop()
            result = await loop.run_in_executor(
                None,
                lambda: _scan_project(
                    project_encoded_name=project,
                    session_limit=limit,
                    include_sessions=include_sessions,
                ),
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
        from flow_sdk.builtin.agentic_process.cli_drivers.claude import ClaudeCliOptions
        from flow_sdk.builtin.agentic_process.cli_drivers.codex import CodexCliOptions
        from flow_sdk.flowpad_types.enums import WorkerType

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
            result_data = body.get("result")

            context_data = dict(context_raw)
            workdir = context_data.pop("workdir", None)
            project_id = context_data.pop("project_id", None)
            # VFS path of the attached entity (trigger, markdown, …); stored on the process for the runs drawer / chat panel queries.
            target_vfs_path = context_data.pop("target_vfs_path", None)

            fork_session = bool(context_data.pop("fork_session", False))
            resume_session_id = context_data.pop("resume_session_id", None)
            additional_dirs: list[str] = list(context_data.pop("additional_dirs", None) or [])

            # Worker selection — accept ``worker_type`` from the AgenticContext
            # so the UI can launch a Codex tab from the same opener flow that
            # spawns Claude. Anything other than ``codex`` falls back to the
            # historical Claude CLI shape.
            worker_type_raw = context_data.pop("worker_type", None) or WorkerType.CLAUDE_CODE.value
            try:
                worker_type = WorkerType(worker_type_raw)
            except ValueError:
                worker_type = WorkerType.CLAUDE_CODE

            model = context_data.pop("model", None) or None
            permission_mode = context_data.pop("permission_mode", "bypassPermissions")
            agents_json = context_data.pop("agents_json", None)
            output_format = context_data.pop("output_format", None)
            if worker_type == WorkerType.CODEX:
                cli_opts = CodexCliOptions(
                    model=model,
                    permission_mode=permission_mode,
                )
                # Codex reads agent specs at runtime from the process entity
                # (``CodexDriver.cli_options`` mirrors them onto ``skill_names``),
                # and doesn't expose ``output_format``/``chrome``/``debug``/
                # ``worktree`` flags — drop them from the unrecognized-fields
                # carry-over.
                context_data.pop("chrome", None)
                context_data.pop("debug", None)
                context_data.pop("worktree", None)
            else:
                cli_opts = ClaudeCliOptions(
                    model=model,
                    permission_mode=permission_mode,
                    agents_json=agents_json,
                    output_format=output_format,
                    chrome=bool(context_data.pop("chrome", False)),
                    debug=bool(context_data.pop("debug", True)),
                    worktree=bool(context_data.pop("worktree", False)),
                )

            if fork_session and resume_session_id and worker_type != WorkerType.CODEX:
                # Codex has no fork concept — fall through to plain resume below.
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

            process = AgenticProcess(
                worker_type=worker_type.value,
                instruction_content="",
                cli_config=cli_opts.to_json(),
                context_data=context_data,
                workdir=workdir,
                visible=visible,
                additional_dirs=additional_dirs,
                project_id=project_id or None,
                target_vfs_path=target_vfs_path or None,
            )
            if resume_session_id and not fork_session:
                process.session_id = resume_session_id
            await process.save(owner)

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

            # Atomic: spawn the linked Shell + PTY before returning so the
            # frontend gets a fully-attached row in one round-trip. Without
            # this the tab strip races a Phase-B refresh and ends up empty.
            try:
                start_resp = await process.start(visible=visible)
            except Exception as start_err:
                logging.exception(
                    f"ComputeNode {self.id} createProcess start error for {process.id}: {start_err}"
                )
                return ApiFailResponse(
                    message=f"Process {process.id} created but failed to start: {start_err}"
                )

            if isinstance(start_resp, ApiFailResponse):
                return start_resp

            return ApiSuccessResponse(
                data={
                    "id": process.id,
                    "type": process.type,
                    "shell_id": process.shell_id,
                    "pty_pid": getattr(process, "pty_pid", None),
                }
            )

        except Exception as e:
            logging.exception(f"ComputeNode {self.id} createProcess error: {e}")
            return ApiFailResponse(message=str(e))

    async def _scan_upsert_session_process(self) -> ApiResponse:
        """Find or create an AgenticProcess for a given session ID.

        Idempotent on ``session_id``: if a process already exists, returns it.
        Otherwise creates a new AgenticProcess with ``session_id`` pre-set and
        flips ``cli_config.resume=True`` when a transcript is found on disk.

        Supports both Claude (default) and Codex via ``workerType``.

        POST body (camelCase):
            sessionId:  str           — session/thread ID
            workdir:    str | None    — working directory
            projectId:  str | None    — project ID for context
            workerType: str | None    — "claude" (default) or "codex"

        Returns: { id, type, session_id, created, worker_type }
        """
        from flow_sdk.builtin.agentic_process import AgenticProcess
        from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter
        from flow_sdk.flowpad_types.enums import WorkerType

        request_info = get_current_request_info()
        if not request_info or not request_info.request:
            return ApiFailResponse(message="No request info available")

        try:
            body = await request_info.get_post_data()
            if not isinstance(body, dict):
                return ApiFailResponse(message="Invalid request body (expected JSON object)")

            session_id = body.get("sessionId")
            if not session_id:
                return ApiFailResponse(message="sessionId is required")

            workdir = body.get("workdir")
            project_id = body.get("projectId")
            worker_type_raw = (body.get("workerType") or "claude").lower()
            is_codex = worker_type_raw in ("codex",)
            cli_factory_key = "codex" if is_codex else "claude"
            wt_enum = WorkerType.CODEX if is_codex else WorkerType.CLAUDE_CODE

            # Resolve workdir + project from the session record before checking
            # for an existing process. The transcript cwd is the authoritative
            # restore location; project_id is derived from it so worktrees and
            # nested checkouts do not collapse into the active dock project.
            session_name: str | None = None
            session_rec = None
            try:
                from flow_sdk.builtin.project import Project

                if is_codex:
                    from flow_sdk.fs_records.codex import CodexSessionRecord
                    session_rec = CodexSessionRecord.get(session_id)
                else:
                    from flow_sdk.fs_records.claude.claude_session import ClaudeSessionRecord
                    session_rec = ClaudeSessionRecord.get(session_id)

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
            existing = await AgenticProcess.get_all(
                entities_filter=QueryFilter(match=ExpressionNode(session_id=session_id))
            )
            if existing:
                process = existing[0]
                changed = False
                context_data = dict(process.context_data or {})
                if workdir and process.workdir != workdir:
                    process.workdir = workdir
                    changed = True
                if workdir and context_data.get("workdir") != workdir:
                    context_data["workdir"] = workdir
                    changed = True
                if project_id and process.project_id != project_id:
                    process._bind_project_id(project_id)
                    changed = True
                if project_id and context_data.get("project_id") != project_id:
                    context_data["project_id"] = project_id
                    changed = True
                if session_name and not process.name:
                    process.name = session_name
                    changed = True
                if changed:
                    process.context_data = context_data
                    await process.save()
                if process.shell_id and (workdir or project_id):
                    try:
                        from flow_sdk.builtin.shell import Shell

                        shell = await Shell.get_by_id(process.shell_id)
                        shell_changed = False
                        if shell and workdir and shell.workdir != workdir:
                            shell.workdir = workdir
                            shell_changed = True
                        if shell and project_id and shell.project_id != project_id:
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
                # Heal pre-existing processes that were persisted before the
                # atomic-start fix: ensure the linked Shell + PTY are attached
                # and the process is visible so the tab strip will surface it.
                if not process.shell_id or not process.visible:
                    try:
                        start_resp = await process.start(visible=True)
                    except Exception as start_err:
                        logging.exception(
                            f"ComputeNode {self.id} upsertSessionProcess heal-start error for {process.id}: {start_err}"
                        )
                        return ApiFailResponse(
                            message=f"Process {process.id} found but failed to start: {start_err}"
                        )
                    if isinstance(start_resp, ApiFailResponse):
                        return start_resp
                return ApiSuccessResponse(
                    data={
                        "id": process.id,
                        "type": process.type,
                        "session_id": process.session_id,
                        "shell_id": process.shell_id,
                        "pty_pid": getattr(process, "pty_pid", None),
                        "worker_type": getattr(process.worker_type, "value", process.worker_type),
                        "created": False,
                    }
                )

            # Create new process directly on this compute node
            owner = request_info.someone_typeid if request_info else None

            context_data = {}
            if workdir:
                context_data["workdir"] = workdir
            if project_id:
                context_data["project_id"] = project_id

            process = AgenticProcess(
                session_id=session_id,
                worker_type=wt_enum,
                use_worker_history=True,
                context_data=context_data,
                project_id=project_id or None,
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
                # Codex resume needs the thread_id passed as the cli session_id
                # (Claude already reads it from process.session_id at args-build time).
                if is_codex:
                    _cmd.session_id = session_id
                process.cli_config = _cmd.to_json()
                rec_cwd = getattr(session_rec, "cwd", None)
                if not process.workdir and rec_cwd:
                    process.workdir = rec_cwd
                await process.save()

            # Atomic: spawn the linked Shell + PTY before returning so the
            # frontend gets a fully-attached row in one round-trip — same
            # pattern as `_scan_create_process`. Without this the resumed
            # AgenticProcess has no shell_id, is filtered out of the visible
            # tab strip, and the route loader silently snaps to a fallback.
            try:
                start_resp = await process.start(visible=True)
            except Exception as start_err:
                logging.exception(
                    f"ComputeNode {self.id} upsertSessionProcess start error for {process.id}: {start_err}"
                )
                return ApiFailResponse(
                    message=f"Process {process.id} created but failed to start: {start_err}"
                )

            if isinstance(start_resp, ApiFailResponse):
                return start_resp

            return ApiSuccessResponse(
                data={
                    "id": process.id,
                    "type": process.type,
                    "session_id": session_id,
                    "shell_id": process.shell_id,
                    "pty_pid": getattr(process, "pty_pid", None),
                    "worker_type": getattr(process.worker_type, "value", process.worker_type),
                    "created": True,
                }
            )

        except Exception as e:
            logging.exception(f"ComputeNode {self.id} upsertSessionProcess error: {e}")
            return ApiFailResponse(message=str(e))
