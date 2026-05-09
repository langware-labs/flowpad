"""Generic transcript route.

``GET /api/v1/transcripts/{worker_type}?path=<absolute_path>``

Loads a worker JSONL transcript via :class:`AgentTranscript` (worker-agnostic
parser) and returns the typed entries plus the extracted session header.
The UI's ``GenericTranscriptViewer`` consumes the response — both claude
and codex paths flow through the same shape.
"""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from flow_sdk.transcript_analyzer.entries import MetaEntry
from flow_sdk.transcript_analyzer.transcript import AgentTranscript

logger = logging.getLogger(__name__)

router = APIRouter()


_SUPPORTED_WORKERS: frozenset[str] = frozenset({"claude", "codex"})


def _error(status_code: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"ok": False, "error_code": code, "error": message},
    )


def _build_header(transcript: AgentTranscript) -> dict:
    """Pull session_meta-style fields onto the response header.

    Mirrors the scan that :meth:`AgentTranscript.to_string` does so the UI
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
        transcript = AgentTranscript(worker_type, p)
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
