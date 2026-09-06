"""Extractor + id mint + asset-hash for JOURNEY records.

A journey is a folder containing ``graph.json`` (a GraphWorkflowDoc of guided_step nodes)
plus ``display.json`` (layout), ``runs/`` (execution journals) and child ``*.html``
pages shown during the journey. Discovery is the generic ``repo_assets_fn``
walk of ``<scope>/agentic-assets/journey/*/``; this module owns the extractor,
id mint and asset-hash.

Freshness tracks ``graph.json`` + child ``*.html`` (the authored pages) — not
``display.json`` or ``runs/``.
"""
from __future__ import annotations

from pathlib import Path

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.graph_workflow_manager.graph_workflow_doc import GraphWorkflowDoc, parse_graph_workflow_doc

GRAPH_JSON = "graph.json"


def _load_doc(journey_dir: Path) -> GraphWorkflowDoc | None:
    try:
        return parse_graph_workflow_doc((journey_dir / GRAPH_JSON).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None




def read_auto_launch(journey_dir: Path) -> bool:
    """The journey's `auto_launch` flag, read from the RAW graph.json — the ONE
    reader (``Journey.auto_launch_enabled`` calls this too; disk is the single
    source of truth).

    Read raw rather than off the parsed GraphWorkflowDoc: `auto_launch` is a journey-only
    concern the shared GraphWorkflowDoc schema doesn't model, so it would be dropped."""
    import json  # noqa: PLC0415

    try:
        raw = json.loads((journey_dir / GRAPH_JSON).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return bool(raw.get("auto_launch", False))


def read_gate(journey_dir: Path) -> dict | None:
    """The journey's `gate` block from the RAW graph.json, or None.

    Journey-only concern outside the shared GraphWorkflowDoc schema (same rationale as
    ``read_auto_launch``). Shape: ``{"requires_capabilities": [kind, ...]}`` —
    the journey is launchable only while at least one listed capability is
    not yet available (there is something left to set up)."""
    import json  # noqa: PLC0415

    try:
        raw = json.loads((journey_dir / GRAPH_JSON).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    gate = raw.get("gate")
    return gate if isinstance(gate, dict) else None


def journey_asset_hash(ref: FSRef) -> float:
    """Max mtime of graph.json + child *.html — display.json and runs/ excluded."""
    base = ref._path
    ts = 0.0
    try:
        ts = max(ts, (base / GRAPH_JSON).stat().st_mtime)
    except OSError:
        pass
    try:
        for p in base.glob("*.html"):
            try:
                ts = max(ts, p.stat().st_mtime)
            except OSError:
                pass
    except OSError:
        pass
    return ts


def extract_journey(ref: FSRef, resolved_id: str) -> list[FSRecord]:
    """Parse a journey folder into a Record row (name/description/content)."""
    path = ref._path
    doc = _load_doc(path) if path.is_dir() else None
    name = (doc.name if doc and doc.name else path.name)
    step_names = " ".join(n.name or n.node_type for n in doc.nodes) if doc else ""
    content = "\n".join(p for p in (name, doc.description if doc else "", step_names) if p)

    rec_kwargs: dict = {
        "type": RecordType.JOURNEY,
        "id": resolved_id,
        "name": name,
        "status": "active",
        "content": content,
    }
    if doc and doc.description:
        rec_kwargs["description"] = doc.description
    if doc:
        steps = [n for n in doc.nodes if n.node_type == "guided_step"]
        rec_kwargs["metadata"] = {"enabled": doc.enabled, "version": doc.version,
                                  "step_count": len(steps)}
    rec = FSRecord(**rec_kwargs)
    object.__setattr__(rec, "_asset_ref", FSRef(path.resolve()))
    return [rec]
