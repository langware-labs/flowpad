"""Generic transcript route.

``GET /api/v1/transcripts/{worker_type}?path=<absolute_path>``

Loads a worker JSONL transcript via :class:`AgentTranscriptFile` (worker-agnostic
parser) and returns the typed entries plus the extracted session header.
The UI's ``GenericTranscriptViewer`` consumes the response — both claude
and codex paths flow through the same shape.
"""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from flow_sdk.transcript_analyzer.entries import MetaEntry
from flow_sdk.transcript_analyzer.resolver import (
    TranscriptNotFoundError,
    resolve_session_jsonl,
)
from flow_sdk.transcript_analyzer.transcript import AgentTranscriptFile

logger = logging.getLogger(__name__)

router = APIRouter()


_SUPPORTED_WORKERS: frozenset[str] = frozenset({"claude", "codex", "copilot"})


def _error(status_code: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"ok": False, "error_code": code, "error": message},
    )


def _build_header(transcript: AgentTranscriptFile) -> dict:
    """Pull session_meta-style fields onto the response header.

    Mirrors the scan that :meth:`AgentTranscriptFile.to_string` does so the UI
    can render a stable header strip (cwd, git, cli_version, originator,
    model_provider) without reaching into MetaEntry payloads.
    """
    out: dict = {}
    for entry in transcript.entries[:5]:
        if isinstance(entry, MetaEntry) and entry.meta_kind == "session_meta":
            payload = entry.payload or {}
            for key in ("cwd", "cli_version", "originator", "model_provider"):
                v = payload.get(key)
                if v:
                    out[key] = v
            git = payload.get("git")
            if isinstance(git, dict):
                out["git"] = {
                    k: git.get(k)
                    for k in ("branch", "commit_hash", "repository_url")
                    if git.get(k)
                }
            break
    return out


async def _post_agent_trace_feed_entry(trace_entity) -> str | None:
    """Best-effort Home Feed entry for a completed session analysis."""
    try:
        from flow_sdk.builtin.feed_entry import FeedEntry, FeedStatus
        from flow_sdk.server.routes.bootstrap import get_or_create_local_user

        user = await get_or_create_local_user()
        feed = FeedEntry(
            feed_status=FeedStatus.NEW.value,
            data={"type_id": str(trace_entity.typeid)},
        )
        feed = await feed.save(user.typeid)
        return feed.id
    except Exception:
        logger.exception("transcripts: failed to post AgentTrace feed entry")
        return None


@router.get("/api/v1/transcripts/{worker_type}")
async def get_transcript(worker_type: str, path: str = ""):
    """Return parsed entries for a transcript JSONL.

    Query params:
        path: absolute filesystem path to the JSONL.

    Response:
        { ok, worker_type, session_id, path, header, entries }
    """
    if worker_type not in _SUPPORTED_WORKERS:
        return _error(400, "INVALID_ARG", f"Unsupported worker_type: {worker_type!r}")
    if not path:
        return _error(400, "INVALID_ARG", "Missing required query param: path")

    p = Path(path)
    if not p.is_absolute():
        return _error(400, "INVALID_ARG", f"Path must be absolute: {path!r}")
    if not p.exists():
        return _error(404, "NOT_FOUND", f"Transcript not found: {path!r}")

    try:
        transcript = AgentTranscriptFile(worker_type, p)
    except Exception as exc:  # noqa: BLE001 — surface the parser failure verbatim
        logger.exception("transcripts: parse failed for %s", path)
        return _error(500, "PARSE_FAILED", str(exc))

    return {
        "ok": True,
        "worker_type": worker_type,
        "session_id": transcript.session_id,
        "path": str(transcript.path),
        "header": _build_header(transcript),
        "entries": [entry.to_dict() for entry in transcript.entries],
    }


@router.get("/api/v1/workers/{worker_type}/{session_id}/trace-skeleton")
async def get_trace_skeleton(worker_type: str, session_id: str):
    """Deterministic AgentTrace skeleton for a session (lanes/segments/markers).

    Server-side twin of ``python -m flow_sdk.transcript_analyzer.synthesizers.
    agent_trace`` so the agent-trace skill works from any workdir (no repo
    venv needed). Synthesis runs in a thread — team sessions parse 80+ files.
    """
    import asyncio

    from flow_sdk.transcript_analyzer.synthesizers.agent_trace import synthesize_agent_trace

    if worker_type not in _SUPPORTED_WORKERS:
        return _error(400, "INVALID_ARG", f"Unsupported worker_type: {worker_type!r}")
    try:
        skeleton = await asyncio.to_thread(synthesize_agent_trace, session_id, worker_type)
    except TranscriptNotFoundError as exc:
        return _error(404, "NOT_FOUND", str(exc))
    except ValueError as exc:
        return _error(400, "INVALID_ARG", str(exc))
    return {"ok": True, "skeleton": skeleton}


@router.post("/api/v1/workers/{worker_type}/{session_id}/agent-trace")
async def create_agent_trace(worker_type: str, session_id: str, request: Request):
    """Create an AgentTrace record for a session from skill annotations.

    Body: ``{"annotations": {...}}`` (the agent-trace skill's judgment layer —
    goals/divergences/issues/verdict). The server re-synthesizes the skeleton,
    merges, and creates a NEW AgentTrace entity every call (analyses are
    history, never overwritten); names are ``trace-<sid8>-<utc compact>``.
    """
    import asyncio
    from datetime import datetime, timezone

    from flow_sdk.builtin.agentic_process import AgenticProcess
    from flow_sdk.builtin.agent_trace import AgentTrace
    from flow_sdk.transcript_analyzer.synthesizers.agent_trace import (
        merge_annotations,
        synthesize_agent_trace,
    )

    if worker_type not in _SUPPORTED_WORKERS:
        return _error(400, "INVALID_ARG", f"Unsupported worker_type: {worker_type!r}")
    try:
        body = await request.json()
    except Exception:
        body = {}
    annotations = (body or {}).get("annotations") or {}
    if not isinstance(annotations, dict):
        return _error(400, "INVALID_ARG", "annotations must be an object")

    try:
        skeleton = await asyncio.to_thread(synthesize_agent_trace, session_id, worker_type)
    except TranscriptNotFoundError as exc:
        return _error(404, "NOT_FOUND", str(exc))
    except ValueError as exc:
        return _error(400, "INVALID_ARG", str(exc))

    trace = merge_annotations(skeleton, annotations)
    try:
        analyzed_process = await AgenticProcess.get_by_session_id(session_id)
    except Exception:
        logger.exception("transcripts: failed to resolve analyzed process for %s", session_id)
        analyzed_process = None
    if analyzed_process:
        trace["analyzed_process_id"] = analyzed_process.id
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    trace["name"] = f"trace-{session_id[:8]}-{stamp}"
    entity = AgentTrace.from_trace(trace)
    await entity.save()
    feed_entry_id = await _post_agent_trace_feed_entry(entity)
    return {
        "ok": True,
        "id": entity.id,
        "asset_ref": entity.asset_ref,
        "summary": trace["summary"],
        "feed_entry_id": feed_entry_id,
    }


@router.get("/api/v1/workers/{worker_type}/{session_id}/transcript")
async def get_worker_session_transcript(worker_type: str, session_id: str):
    """Return parsed entries for a worker's session, resolved by session id.

    Server resolves the on-disk JSONL path via ``resolve_session_jsonl``
    (Claude: globs ``~/.claude/projects/*/<sid>.jsonl``; Codex: globs
    ``~/.codex/sessions/**/rollout-*-<sid>.jsonl``; Copilot:
    ``~/.copilot/session-state/<sid>/events.jsonl``). Callers never need to
    know the encoded directory layout — pass ``(worker_type, session_id)``
    and get the transcript.

    Response shape matches ``GET /api/v1/transcripts/{worker_type}?path=``.
    """
    if worker_type not in _SUPPORTED_WORKERS:
        return _error(400, "INVALID_ARG", f"Unsupported worker_type: {worker_type!r}")
    if not session_id:
        return _error(400, "INVALID_ARG", "Missing session_id")
    try:
        path = resolve_session_jsonl(worker_type, session_id)
    except TranscriptNotFoundError as exc:
        return _error(404, "NOT_FOUND", str(exc))
    except ValueError as exc:
        return _error(400, "INVALID_ARG", str(exc))

    try:
        transcript = AgentTranscriptFile(worker_type, path)
    except Exception as exc:  # noqa: BLE001
        logger.exception("transcripts: parse failed for %s", path)
        return _error(500, "PARSE_FAILED", str(exc))

    return {
        "ok": True,
        "worker_type": worker_type,
        "session_id": transcript.session_id,
        "path": str(transcript.path),
        "header": _build_header(transcript),
        "entries": [entry.to_dict() for entry in transcript.entries],
    }
