"""Walker + extractor + id mint for DATASET records.

A dataset is a folder under ``assets/datasets/`` containing a ``dataset.json``
manifest (which is also the walker's marker file). The manifest declares the
physical layout; the example rows live beside it:

    assets/datasets/<slug>/
      dataset.json                 # {id?, title, description, data_layout, field_spec, delimiter}
      data.csv                     # data_layout == "csv"
      examples/0001/{input,expected}.txt [meta.json]   # data_layout == "io_folder"

``iter_examples`` is the single parser for BOTH layouts — it normalizes each
into the shared ``Example`` shape. Modeled on ``functions/whiteboard.py``.

Type metadata lives in ``flow_sdk/schema/type_info/dataset_type_info.py``; this
module provides the walker + slot functions only.
"""
from __future__ import annotations

import csv
import json
import uuid
from pathlib import Path
from typing import Any

from flow_sdk.builtin.dataset import DataLayoutEnum, Example, ExampleKind
from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.identifier import adopt_entity_id, mint_uuid
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType

MANIFEST = "dataset.json"
CSV_FILE = "data.csv"
EXAMPLES_DIR = "examples"


# ── walker ────────────────────────────────────────────────────────────────────

def dataset_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    """Emit one DATASET FSRef per ``assets/datasets/<slug>/`` folder containing a
    ``dataset.json`` manifest."""
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        root = Path(node.path) / "assets" / "datasets"
        if not root.is_dir():
            continue
        for entry in sorted(root.iterdir()):
            if not entry.is_dir():
                continue
            if not (entry / MANIFEST).is_file():
                continue
            key = str(entry.resolve())
            if key in seen:
                continue
            seen.add(key)
            out.append(FSRef(entry, record_type=RecordType.DATASET, parent=node))
    return out


# ── id helpers ────────────────────────────────────────────────────────────────

def _load_manifest(dataset_dir: Path) -> dict[str, Any]:
    """Load dataset.json, returning {} when absent or malformed."""
    try:
        data = json.loads((dataset_dir / MANIFEST).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _dataset_id_from_path(path: Path) -> str:
    """Stable uuid5 derived from the resolved folder path."""
    return mint_uuid(f"{RecordType.DATASET}:{path.resolve()}", namespace=uuid.NAMESPACE_DNS)


def _id_from_manifest(manifest: dict[str, Any], path: Path) -> str:
    """Prefer the manifest's ``id`` (validate-on-adopt, v4/v5 only); else mint a
    stable uuid5 from the folder path."""
    return adopt_entity_id(manifest.get("id")) or _dataset_id_from_path(path)


def dataset_gen_id(ref: FSRef) -> str:
    """Resolve a dataset's id. Idempotent — re-running yields the same id."""
    path = ref._path
    if not path.is_dir():
        return _dataset_id_from_path(path)
    return _id_from_manifest(_load_manifest(path), path)


# ── parser (shared by both layouts) ───────────────────────────────────────────

def _example_id(dataset_id: str, key: str) -> str:
    """Deterministic per-example uuid5 of ``f"{dataset_id}:{key}"``."""
    return mint_uuid(f"{dataset_id}:{key}", namespace=uuid.NAMESPACE_DNS)


def _coerce_enum(value: Any, enum_cls: type, default: Any) -> Any:
    """Map a raw value onto ``enum_cls``, defaulting on absence or invalid value."""
    try:
        return enum_cls(str(value)) if value else default
    except ValueError:
        return default


def iter_examples(
    base: str | Path,
    layout: DataLayoutEnum,
    field_spec: dict[str, str],
    delimiter: str,
    *,
    dataset_id: str,
) -> list[Example]:
    """Parse a dataset folder into ``Example`` rows for either layout.

    ``field_spec`` maps a canonical field name to the actual source column/key
    name, e.g. ``{"input": "question", "expected": "answer"}``. Unmapped fields
    use their canonical name. For CSV, any leftover columns land in
    ``Example.metadata``; for IO_FOLDER, the per-example ``meta.json`` is used.
    """
    base_path = Path(base)
    rows: list[Example] = []

    if layout == DataLayoutEnum.CSV:
        csv_path = base_path / CSV_FILE
        if not csv_path.is_file():
            return rows
        input_col = field_spec.get("input", "input")
        expected_col = field_spec.get("expected", "expected")
        kind_col = field_spec.get("kind", "kind")
        consumed = {input_col, expected_col, kind_col}
        with csv_path.open(newline="", encoding="utf-8") as fh:
            for i, raw in enumerate(csv.DictReader(fh, delimiter=delimiter or ",")):
                rows.append(Example(
                    id=_example_id(dataset_id, str(i)),
                    kind=_coerce_enum(raw.get(kind_col), ExampleKind, ExampleKind.TRAIN),
                    input=raw.get(input_col) or "",
                    expected=raw.get(expected_col),
                    metadata={k: v for k, v in raw.items() if k not in consumed},
                ))
        return rows

    # IO_FOLDER
    examples_dir = base_path / EXAMPLES_DIR
    if not examples_dir.is_dir():
        return rows
    for ex_dir in sorted(examples_dir.iterdir()):
        if not ex_dir.is_dir():
            continue
        input_path = ex_dir / "input.txt"
        if not input_path.is_file():
            continue
        meta: dict[str, Any] = {}
        meta_path = ex_dir / "meta.json"
        if meta_path.is_file():
            try:
                loaded = json.loads(meta_path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    meta = loaded
            except (OSError, json.JSONDecodeError):
                meta = {}
        expected_path = ex_dir / "expected.txt"
        rows.append(Example(
            id=_example_id(dataset_id, ex_dir.name),
            kind=_coerce_enum(meta.get("kind"), ExampleKind, ExampleKind.TRAIN),
            input=input_path.read_text(encoding="utf-8"),
            expected=expected_path.read_text(encoding="utf-8") if expected_path.is_file() else None,
            metadata=meta,
        ))
    return rows


# ── extractor ─────────────────────────────────────────────────────────────────

def extract_dataset(ref: FSRef) -> list[FSRecord]:
    """Parse a dataset folder into a single FSRecord with denormalized counts."""
    path = ref._path
    if not path.is_dir() or not (path / MANIFEST).is_file():
        return []
    manifest = _load_manifest(path)

    ds_id = _id_from_manifest(manifest, path)
    layout = _coerce_enum(manifest.get("data_layout"), DataLayoutEnum, DataLayoutEnum.CSV)
    field_spec = manifest.get("field_spec") if isinstance(manifest.get("field_spec"), dict) else {}
    delimiter = manifest.get("delimiter") or ","
    examples = iter_examples(path, layout, field_spec, delimiter, dataset_id=ds_id)

    kind_counts: dict[str, int] = {}
    for ex in examples:
        kind_counts[ex.kind] = kind_counts.get(ex.kind, 0) + 1

    name = manifest.get("title") or path.name
    description = manifest.get("description") if isinstance(manifest.get("description"), str) else ""
    content = "\n".join(p for p in (name, description) if p)

    metadata = {
        **manifest,
        "data_layout": str(layout),
        "field_spec": field_spec,
        "delimiter": delimiter,
        "num_examples": len(examples),
        "kind_counts": kind_counts,
    }

    rec_kwargs: dict[str, Any] = {
        "type": RecordType.DATASET,
        "id": ds_id,
        "name": name,
        "status": "active",
        "content": content,
        "metadata": metadata,
    }
    if description:
        rec_kwargs["description"] = description
    rec = FSRecord(**rec_kwargs)
    object.__setattr__(rec, "_asset_ref", FSRef(path.resolve()))
    return [rec]


# ── asset hash (folder freshness) ─────────────────────────────────────────────

def dataset_asset_hash(ref: FSRef) -> float:
    """mtime across the dataset's inner content files.

    The base implementation hashes the folder's own mtime, which does NOT update
    when a child file's *content* is edited. Datasets are folder-based, so this
    stats the manifest + the layout-specific data (``data.csv`` and the
    ``examples/`` tree) instead — otherwise edits to ``data.csv`` would never
    re-index. Mirrors ``whiteboard_asset_hash``.
    """
    base = ref._path
    ts = 0.0
    # Manifest + CSV are exact, single-file signals.
    for child in (base / MANIFEST, base / CSV_FILE):
        try:
            ts = max(ts, child.stat().st_mtime)
        except OSError:
            pass
    # IO_FOLDER content lives in nested files; a folder's own mtime doesn't move
    # when a child's content is edited, so walk the example files for freshness.
    examples_dir = base / EXAMPLES_DIR
    if examples_dir.is_dir():
        for inner in examples_dir.rglob("*"):
            try:
                ts = max(ts, inner.stat().st_mtime)
            except OSError:
                pass
    return ts
