"""Extractor + id mint + asset-hash for AGENTIC_FLOW records.

An agentic flow is a folder containing ``graph.json`` (the flow document —
see ``flow_sdk/flow_manager/flow_doc.py``) plus ``display.json`` (layout),
``scripts/`` (function node scripts) and ``runs/`` (execution journals). Cloned
from the whiteboard walker family.

Freshness deliberately tracks ONLY ``graph.json`` + ``scripts/*``:
``display.json`` (canvas drags) and ``runs/`` (execution traffic) must never
trigger a reindex of the flow.
"""
from __future__ import annotations

from pathlib import Path

from flow_sdk.flow_manager.flow_doc import FlowDoc, parse_flow_doc
from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.functions._folder_capsule import (
    read_folder_capsule_id,
)
from flow_sdk.fs_store.record_types import RecordType

GRAPH_JSON = "graph.json"
def _load_doc(flow_dir: Path) -> FlowDoc | None:
    try:
        return parse_flow_doc((flow_dir / GRAPH_JSON).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def agentic_flow_id_from_folder(ref: FSRef | Path) -> object | None:
    path = Path(getattr(ref, "_path", ref))
    cap = read_folder_capsule_id(path)
    if cap:
        return cap
    doc = _load_doc(path)
    from flow_sdk.fs_store.identifier import adopt_entity_id  # noqa: PLC0415

    return adopt_entity_id(doc.id if doc else None)


def agentic_flow_asset_hash(ref: FSRef) -> float:
    """Max mtime of graph.json + scripts/* — display.json and runs/ excluded."""
    base = ref._path
    ts = 0.0
    try:
        ts = max(ts, (base / GRAPH_JSON).stat().st_mtime)
    except OSError:
        pass
    scripts = base / "scripts"
    if scripts.is_dir():
        for p in scripts.iterdir():
            try:
                ts = max(ts, p.stat().st_mtime)
            except OSError:
                pass
    return ts


def extract_agentic_flow(ref: FSRef, resolved_id: str) -> list[FSRecord]:
    """Parse a flow folder into a Record row (name/description/enabled/content)."""
    path = ref._path
    doc = _load_doc(path) if path.is_dir() else None
    name = (doc.name if doc and doc.name else path.name)
    node_names = " ".join(n.name or n.node_type for n in doc.nodes) if doc else ""
    content = "\n".join(p for p in (name, doc.description if doc else "", node_names) if p)

    rec_kwargs: dict = {
        "type": RecordType.AGENTIC_FLOW,
        "id": resolved_id,
        "name": name,
        "status": "active",
        "content": content,
    }
    if doc and doc.description:
        rec_kwargs["description"] = doc.description
    if doc:
        rec_kwargs["metadata"] = {"enabled": doc.enabled, "version": doc.version,
                                  "node_count": len(doc.nodes), "edge_count": len(doc.edges)}
    rec = FSRecord(**rec_kwargs)
    object.__setattr__(rec, "_asset_ref", FSRef(path.resolve()))
    return [rec]
