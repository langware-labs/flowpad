"""Filesystem contracts independent of application entities."""
from __future__ import annotations

from collections import Counter
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.schema.data_spec.dataset_manifest_spec import DatasetManifestSpec
from flow_sdk.schema.data_spec.layout import CSV_FILE, ROWS_DIR, is_binary

MANIFEST = DatasetManifestSpec.main_file


def dataset_counts(kinds: Iterable[str]) -> dict:
    """``num_rows`` + ``kind_counts`` over row kinds."""
    counts = dict(Counter(kinds))
    return {"num_rows": sum(counts.values()), "kind_counts": counts}


def row_facts(row: Any) -> dict:
    """A PARSED row as the per-row facts ``derive_counts`` reads — the shape
    ``FolderLayout.index`` emits for a row without parsing it."""
    first = row.input[0] if isinstance(row.input, list) and row.input else row.input
    return {
        "kind": str(getattr(row.kind, "value", row.kind)),
        "annotated": getattr(row, "ground_truth", None) is not None,  # THE definition of num_annotated
        "multi_output": isinstance(row.output, list) and len(row.output) > 1,
        "binary_input": is_binary(first),
    }


def derive_counts(facts: Iterable[Mapping[str, Any]]) -> dict:
    """THE deriver of a dataset's five counters, from per-row facts (``row_facts``
    over parsed rows, or ``FolderLayout.index`` entries). The indexer, the entity's
    validator and ``Dataset.refresh_counts`` all go through here, so a row write
    and a reindex can never disagree on any of them."""
    facts = list(facts)
    return {
        **dataset_counts(f["kind"] for f in facts),
        "num_annotated": sum(1 for f in facts if f["annotated"]),
        "num_multi_output": sum(1 for f in facts if f["multi_output"]),
        "num_binary_inputs": sum(1 for f in facts if f["binary_input"]),
    }


def derive_dataset(data: dict, root: Path, header_raw: dict) -> None:
    """The counts the disk implies — facts about the rows, never authored."""
    data["name"] = data.get("title") or root.name
    data.update(derive_counts(row_facts(row) for row in data.get("rows") or []))


def dataset_asset_hash(ref: FSRef) -> int:
    """mtime across the dataset's inner content files.

    The base implementation hashes the folder's own mtime, which does NOT update
    when a child file's *content* is edited. Datasets are folder-based, so this
    stats the manifest + the layout-specific data (``data.csv`` and the
    ``rows/`` tree) instead — otherwise edits to ``data.csv`` would never
    re-index. Mirrors ``chart_asset_hash``.
    """
    from flow_sdk.datasets.stores import rows_root_of  # noqa: PLC0415

    base = ref._path
    try:
        store = rows_root_of(base)
    except ValueError:   # a data source the project does not declare: the manifest alone says it changed
        store = base
    ts = 0
    # Manifest + CSV are exact, single-file signals (the CSV lives in the dataset's store).
    for child in (base / MANIFEST, store / CSV_FILE):
        try:
            ts = max(ts, child.stat().st_mtime_ns)
        except OSError:
            pass
    # IO_FOLDER content lives in nested files; a folder's own mtime doesn't move
    # when a child's content is edited, so walk the row files for freshness.
    rows_dir = store / ROWS_DIR
    if rows_dir.is_dir():
        for inner in rows_dir.rglob("*"):
            try:
                ts = max(ts, inner.stat().st_mtime_ns)
            except OSError:
                pass
    return ts
