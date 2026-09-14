"""Filesystem contracts independent of application entities."""
from __future__ import annotations

from collections import Counter
from collections.abc import Iterable
from pathlib import Path

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.schema.data_spec.dataset_spec import DEFAULT_DATASET_SPEC, DataLayoutEnum, ExampleSpec
from flow_sdk.schema.data_spec.layout import CSV_FILE, EXAMPLES_DIR, is_binary, layout_for

MANIFEST = "dataset.json"


def dataset_counts(kinds: Iterable[str]) -> dict:
    """Counts shared by filesystem reads and row refresh adapters."""
    counts = dict(Counter(kinds))
    return {"num_examples": sum(counts.values()), "kind_counts": counts}


def derive_dataset(data: dict, root: Path, header_raw: dict) -> None:
    """The counts the disk implies — facts about the rows, never authored.
    The same row counts feed application hydration; binary and annotation
    counts also depend on the filesystem layout."""
    data["name"] = data.get("title") or root.name
    examples = data.get("examples") or []
    data.update(dataset_counts(str(example.kind) for example in examples))
    data["num_annotated"] = layout_for(data.get("data_layout")).count_annotated(root, examples)
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
