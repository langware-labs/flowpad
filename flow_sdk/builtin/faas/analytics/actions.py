"""AnalyticsActionsMixin — cost / context analytics for ComputeNode.

These are NOT filesystem scans: cost is a pure aggregation over indexed
sessions and context is a ``claude -p /context`` subprocess. They live here
(faas/analytics) rather than the indexer.
"""

from __future__ import annotations

import asyncio
import logging

from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse


class AnalyticsActionsMixin:
    async def _analytics_cost_overview(self) -> ApiResponse:
        """Cost overview aggregated from indexed sessions (action: get-cost-overview)."""
        from flow_sdk.builtin.faas.analytics.cost_overview import (
            get_cost_overview,
            load_recent_sessions_for_cost,
        )

        request_info = get_current_request_info()
        limit_str = request_info.get_param("limit") if request_info else None
        limit = int(limit_str) if limit_str else 100
        try:
            sessions = await asyncio.to_thread(load_recent_sessions_for_cost, limit)
            return ApiSuccessResponse(data=get_cost_overview(sessions))
        except Exception as e:
            logging.exception("get-cost-overview failed: %s", e)
            return ApiFailResponse(message=str(e))

    async def _analytics_claude_context(self) -> ApiResponse:
        """Claude Code /context probe (action: get-claude-context)."""
        from flow_sdk.builtin.faas.analytics.claude_context import get_claude_context_sync

        request_info = get_current_request_info()
        session_id = request_info.get_param("session_id") if request_info else None
        session_id = session_id or None

        session_title: str | None = None
        if session_id:
            try:
                from flow_sdk.fs_store.indexer.functions.claude_sessions import get_claude_session

                rec = get_claude_session(session_id)
                name = getattr(rec, "name", None) if rec is not None else None
                # Don't surface a bare UUID as a title.
                session_title = name if name and name != session_id else None
            except Exception:
                session_title = None

        try:
            result = await asyncio.to_thread(
                get_claude_context_sync,
                session_id=session_id,
                session_title=session_title,
            )
            return ApiSuccessResponse(data=result)
        except Exception as e:
            logging.exception("get-claude-context failed: %s", e)
            return ApiFailResponse(message=str(e))
