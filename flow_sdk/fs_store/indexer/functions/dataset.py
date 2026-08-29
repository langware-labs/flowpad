"""Extractor + id mint for DATASET records.

A dataset is a folder under ``agentic-assets/dataset/`` containing a ``dataset.json``
manifest (which is also the walker's marker file). The manifest declares the
physical layout; the example rows live beside it:

    agentic-assets/dataset/<slug>/
      dataset.json                 # {"metadata": {id?, data_layout, field_spec, spec, …}, "data": {…}}
      data.csv                     # data_layout == "csv"
      examples/0001/...            # data_layout == "io_folder" (see below)

Every dataset JSON file (``dataset.json``, ``example.json``, ``«slot».json``) is a
two-section document — ``{"metadata": {…}, "data": {…}}``. ``metadata`` holds
flowpad-managed known fields; ``data`` is a free, use-case-owned object. Sections
are mandatory: a flat doc yields empty sections (``_load_doc``).

For ``io_folder`` each ``examples/<name>/`` dir carries up to three slots —
``input``, ``output`` (candidate), ``ground_truth`` (gold) — where each slot is
a file ``«base».«ext»``, a folder ``«base»/``, or numbered occurrences
``«base»-«N»`` (multiple outputs / consensus annotations). A sibling
``«base»[-N].json`` is that artifact's two-section sidecar (``.json`` is never slot
data). Per-example metadata lives in ``example.json`` (alias: ``meta.json``).
Back-compat: a legacy ``expected.txt`` is re-keyed under ``ground_truth`` when no
native gold exists.

``iter_examples`` is the single parser for BOTH layouts — each row becomes one
plain-JSON row that MIRRORS the example directory: a file is a ``str`` holding
its example-relative path, a folder is a ``dict`` of its members, and a sidecar
is a sibling ``{"metadata", "data"}`` dict keyed by its full filename. Sidecar and
data keys can never collide — a data key is a filename STEM and carries no dot,
a sidecar key always does — which is what lets ``_is_data_key`` be exact.

Nothing here decodes a file: a leaf carries a reference and reading the bytes is
the consumer's job, so a dataset of PDFs stays cheap to index.

Type metadata lives in ``flow_sdk/schema/type_info/dataset_type_info.py``; this
module provides the walker and parser only.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.identifier import adopt_entity_id
from flow_sdk.fs_store.indexer.functions._folder_capsule import (
    read_folder_capsule_id,
)
from flow_sdk.schema.data_spec.dataset_spec import DEFAULT_DATASET_SPEC, DataLayoutEnum, ExampleSpec
from flow_sdk.schema.data_spec.layout import CSV_FILE, EXAMPLES_DIR, is_binary, layout_for, load_doc

logger = logging.getLogger(__name__)

MANIFEST = "dataset.json"


# ── manifest + id helpers ──────────────────────────────────────────────────────

def _load_manifest(dataset_dir: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    """Load dataset.json as ``(metadata, data)``; both ``{}`` when absent."""
    return load_doc(dataset_dir / MANIFEST)


def dataset_id_from_folder(ref: FSRef | Path) -> object | None:
    path = Path(getattr(ref, "_path", ref))
    cap = read_folder_capsule_id(path)
    if cap:
        return cap
    meta, _ = _load_manifest(path)
    return adopt_entity_id(meta.get("id"))


# ── parser (shared by both layouts) ───────────────────────────────────────────

# ── rows ──────────────────────────────────────────────────────────────────────

def iter_examples(
    base: str | Path,
    layout: DataLayoutEnum,
    field_spec: dict[str, str],
    delimiter: str,
    *,
    dataset_id: str,
) -> list[ExampleSpec]:
    """The UNTYPED read: every row as ``DEFAULT_DATASET_SPEC``'s example type.
    The on-disk grammar lives in ``flow_sdk/schema/data_spec/layout.py``."""
    return layout_for(layout).read(
        Path(base), DEFAULT_DATASET_SPEC.example_type(),
        dataset_id=dataset_id, field_spec=field_spec, delimiter=delimiter,
    )


# ── extractor ─────────────────────────────────────────────────────────────────

def derive_dataset(data: dict, root: Path, header_raw: dict) -> None:
    """The counts the disk implies — facts about the rows, never authored.
    ``num_examples``/``kind_counts`` are the entity's own validator; these three
    need ``is_binary``, which is a layout question."""
    data["name"] = data.get("title") or root.name
    examples = data.get("examples") or []
    data["num_annotated"] = sum(1 for ex in examples if ex.ground_truth is not None)
    data["num_multi_output"] = sum(1 for ex in examples if isinstance(ex.output, list) and len(ex.output) > 1)
    data["num_binary_inputs"] = sum(
        1 for ex in examples if is_binary(ex.input[0] if isinstance(ex.input, list) else ex.input)
    )


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
