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

    async def _scan_create_agentic_processor(self) -> ApiResponse:
        """Create an AgenticProcessor bound to this ComputeNode.

        Ported from FlowPad: flowpad/hub/builtin/faas/compute_node.py
        The processor's compute_node_id is set internally and not exposed to frontend.

        Returns:
            AgenticProcessor entity data
        """
        from flow_sdk.builtin.agentic_process import AgenticProcessor

        try:
            processor = AgenticProcessor()
            # In production, compute_node_id is set on the processor entity.
            # Desktop mode: we don't have that field on the simplified entity,
            # so we just create and save.

            request_info = get_current_request_info()
            await processor.save(owner=request_info.someone_typeid if request_info else None)

            logging.info(f"ComputeNode {self.id} created AgenticProcessor {processor.id}")

            return ApiSuccessResponse(
                data={
                    "id": processor.id,
                    "type": processor.type,
                }
            )

        except Exception as e:
            logging.exception(f"ComputeNode {self.id} createAgenticProcessor error: {e}")
            return ApiFailResponse(message=str(e))

    async def _scan_upsert_session_process(self) -> ApiResponse:
        """Find or create an AgenticProcess for a given Claude Code session ID.

        Ported from FlowPad: flowpad/hub/builtin/faas/compute_node.py
        If a process with matching worker_session_id exists, return it.
        Otherwise, create a new AgenticProcessor + AgenticProcess with
        worker_session_id pre-set.

        POST body (camelCase):
            sessionId: str - Claude Code session ID
            workdir: str | None - Working directory
            projectId: str | None - Project ID for context

        Returns:
            AgenticProcess data with { id, type, processor_id, worker_session_id, created }
        """
        from flow_sdk.builtin.agentic_process import AgenticProcess, AgenticProcessor
        from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter

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

            # Try to find existing process by worker_session_id
            existing = await AgenticProcess.get_all(
                entities_filter=QueryFilter(match=ExpressionNode(worker_session_id=session_id))
            )
            if existing:
                process = existing[0]
                return ApiSuccessResponse(
                    data={
                        "id": process.id,
                        "type": process.type,
                        "processor_id": process.processor_id,
                        "worker_session_id": process.worker_session_id,
                        "created": False,
                    }
                )

            # Resolve workdir + project + project_encoded_name from ClaudeSessionRecord
            project_encoded_name = None
            try:
                from flow_sdk.builtin.project import Project
                from flow_sdk.fs_records.claude.claude_session import ClaudeSessionRecord

                session_rec = ClaudeSessionRecord.discover_one(session_id)
                if session_rec:
                    if session_rec.cwd and not workdir:
                        workdir = session_rec.cwd
                    project_encoded_name = getattr(session_rec, "project_encoded_name", None)
                if workdir and not project_id:
                    projects = await Project.get_all()
                    best, best_len = None, 0
                    for p in projects:
                        mp = getattr(p, "fs_storage_mount_path", None)
                        if mp and workdir.startswith(str(mp)) and len(mp) > best_len:
                            best, best_len = p, len(mp)
                    if best:
                        project_id = best.id
            except Exception:
                pass

            # Create new processor + process
            processor = AgenticProcessor()
            owner = request_info.someone_typeid if request_info else None
            await processor.save(owner=owner)

            context_data = {"compute_node_id": f"{self.type}-{self.id}"}
            if workdir:
                context_data["workdir"] = workdir
            if project_id:
                context_data["project_id"] = project_id

            process = AgenticProcess(
                processor_id=processor.id,
                worker_session_id=session_id,
                use_worker_history=True,
                context_data=context_data,
                compute_node_id=str(self.typeid),
                project_id=project_id or None,
                project_encoded_name=project_encoded_name or None,
            )
            await process.save(owner=owner)

            logging.info(
                f"ComputeNode {self.id} upserted AgenticProcess {process.id} for session {session_id} (created). "
                f"worker_session_id on saved object={process.worker_session_id}"
            )

            # Set resume flag if transcript exists on disk (O(1) with workdir, O(P) fallback).
            # Once resume=True is stored we skip this check on subsequent calls.
            if not process.cli_config.get("resume"):
                record = ClaudeSessionRecord.discover_one(session_id, project=process.workdir)
                if record:
                    from flow_sdk.builtin.cli_workers import factory as _cli_factory
                    _cmd = _cli_factory(process.cli_config, worker_type="claude")
                    _cmd.resume = True
                    process.cli_config = _cmd.to_json()
                    if not process.workdir and record.cwd:
                        process.workdir = record.cwd
                    await process.save()

            return ApiSuccessResponse(
                data={
                    "id": process.id,
                    "type": process.type,
                    "processor_id": processor.id,
                    "worker_session_id": session_id,
                    "created": True,
                }
            )

        except Exception as e:
            logging.exception(f"ComputeNode {self.id} upsertSessionProcess error: {e}")
            return ApiFailResponse(message=str(e))
