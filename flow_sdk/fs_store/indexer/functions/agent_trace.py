"""Walker + extractor + id mint for AGENT_TRACE records.

Agent traces live at ``<scope>/.claude/agent_traces/<name>/trace.json`` — one
folder per analyzed session, the JSON being the full trace payload written by
the agent-trace skill (see ``flow_sdk/transcript_analyzer/synthesizers/agent_trace.py``
for the schema). The extractor reads only the small ``summary`` block into the
record (whiteboard-style: the payload — lanes/segments/events — is deliberately
excluded from FTS).
"""

from __future__ import annotations

import json
from pathlib import Path

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType

TRACE_JSON = "trace.json"


def agent_trace_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        traces_root = Path(node.path) / ".claude" / "agent_traces"
        if not traces_root.is_dir():
            continue
        for trace_dir in sorted(traces_root.iterdir()):
            doc = trace_dir / TRACE_JSON
            if not doc.is_file():
                continue
            key = str(doc.resolve())
            if key in seen:
                continue
            seen.add(key)
            out.append(FSRef(doc, record_type=RecordType.AGENT_TRACE, parent=node))
    return out


def _load_trace(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _trace_id_from_path(path: Path) -> str:
    """UUID5 from resolved path — stable across rescans."""
    from flow_sdk.fs_store.identifier import mint_uuid  # noqa: PLC0415
    return mint_uuid(str(path.resolve()))


def _adopt_doc_id(data: dict) -> str | None:
    """The trace's embedded ``id``, validated on adopt (v4/v5 only)."""
    from flow_sdk.fs_store.identifier import adopt_entity_id  # noqa: PLC0415
    return adopt_entity_id(data.get("id"))


def agent_trace_id(ref: FSRef) -> str:
    """Cheap id: prefer the trace's embedded ``id``; else uuid5(path)."""
    return _adopt_doc_id(_load_trace(ref._path)) or _trace_id_from_path(ref._path)


def extract_agent_trace(ref: FSRef) -> list[FSRecord]:
    """Parse a trace.json into a Record — summary fields only.

    FTS content is name + verdict + verdict_reason; the trace payload itself
    never enters the index (it can be megabytes of tool-call previews).
    """
    path = ref._path
    data = _load_trace(path)
    summary = data.get("summary") if isinstance(data.get("summary"), dict) else {}
    name = str(data.get("name") or path.parent.name)
    verdict = summary.get("verdict")
    verdict_reason = summary.get("verdict_reason")
    rec_id = _adopt_doc_id(data) or _trace_id_from_path(path)

    content_parts = [p for p in (name, verdict, verdict_reason) if p]
    rec = FSRecord(
        type=RecordType.AGENT_TRACE,
        id=rec_id,
        name=name,
        session_id=str(data.get("session_id") or ""),
        worker_type=str(data.get("worker_type") or "claude"),
        verdict=verdict,
        verdict_reason=verdict_reason,
        duration_ms=summary.get("duration_ms"),
        cost_usd=summary.get("cost_usd"),
        issue_count=summary.get("issue_count") or 0,
        divergence_count=summary.get("divergence_count") or 0,
        lane_count=summary.get("lane_count") or 1,
        content="\n".join(content_parts),
    )
    rec.source_file = str(path)
    object.__setattr__(rec, "_asset_ref", FSRef(path))
    return [rec]
