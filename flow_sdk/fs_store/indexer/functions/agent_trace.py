"""Extractor + id mint for AGENT_TRACE records.

Agent traces live at ``<scope>/agentic-assets/agent_trace/<name>/trace.json`` — one
folder per analyzed session, the JSON being the full trace payload written by
the agent-trace skill (see ``flow_sdk/transcript_analyzer/synthesizers/agent_trace.py``
for the schema). The extractor reads only the small ``summary`` block into the
record (whiteboard-style: the payload — lanes/segments/events — is deliberately
excluded from FTS).
"""

from __future__ import annotations

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.functions._report_common import load_report, report_id_from_path


def _adopt_doc_id(data: dict) -> str | None:
    """The trace's embedded ``id``, validated on adopt (v4/v5 only)."""
    from flow_sdk.api.api_types.identifier import adopt_entity_id  # noqa: PLC0415
    return adopt_entity_id(data.get("id"))


def agent_trace_id(ref: FSRef) -> str:
    """Cheap id: prefer the trace's embedded ``id``; else uuid5(path)."""
    return _adopt_doc_id(load_report(ref._path)) or report_id_from_path(ref._path)
