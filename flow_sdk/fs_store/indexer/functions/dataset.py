"""Extractor + id mint for DATASET records.

A dataset is a folder under ``agentic-assets/dataset/`` containing a ``dataset.json``
manifest (which is also the walker's marker file). The manifest declares the
physical layout; the example rows live beside it:

    agentic-assets/dataset/<slug>/
      dataset.json                 # {"metadata": {id?, data_layout, field_spec, schema, …}, "data": {…}}
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
Back-compat: ``input.txt``/``expected.txt`` still populate ``Example.input`` /
``Example.expected`` (the latter folds onto the ground_truth slot).

``iter_examples`` is the single parser for BOTH layouts — it normalizes each
into the shared ``Example`` shape. Modeled on ``functions/whiteboard.py``.

Type metadata lives in ``flow_sdk/schema/type_info/dataset_type_info.py``; this
module provides the slot functions only.
"""
from __future__ import annotations

import csv
import json
import uuid
from pathlib import Path
from typing import Any

from flow_sdk.builtin.dataset import (
    EXAMPLE_META,  # canonical per-example metadata filename (model-owned)
    ArtifactKind,
    DataLayoutEnum,
    Example,
    ExampleArtifact,
    ExampleKind,
    ExampleSlot,
)
from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.identifier import adopt_entity_id, mint_uuid
from flow_sdk.fs_store.indexer.functions._folder_capsule import (
    read_folder_capsule_id,
)
from flow_sdk.fs_store.record_types import RecordType

MANIFEST = "dataset.json"
CSV_FILE = "data.csv"
EXAMPLES_DIR = "examples"

# IO_FOLDER per-example layout.
SLOT_BASES = ("input", "output", "ground_truth")
EXAMPLE_META_ALIAS = "meta.json"       # back-compat alias (example.json wins)
EXPECTED_LEGACY = "expected"           # legacy expected.txt → folded onto ground_truth
TEXT_EXTS = {".txt", ".md"}            # only these data files are decoded into .text


# ── manifest + id helpers ──────────────────────────────────────────────────────

def _load_json_dict(path: Path) -> dict[str, Any]:
    """Read a JSON object from ``path``; ``{}`` when absent, malformed, or non-dict."""
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return loaded if isinstance(loaded, dict) else {}


def _load_doc(path: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    """Read a two-section dataset JSON → ``(metadata, data)``.

    Every dataset JSON file is ``{"metadata": {...}, "data": {...}}``. Each
    section defaults to ``{}`` when absent or non-dict. A flat doc (neither
    section) yields ``({}, {})`` — the two-section structure is mandatory.
    """
    obj = _load_json_dict(path)
    meta, data = obj.get("metadata"), obj.get("data")
    return (
        meta if isinstance(meta, dict) else {},
        data if isinstance(data, dict) else {},
    )


def _load_manifest(dataset_dir: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    """Load dataset.json as ``(metadata, data)``; both ``{}`` when absent."""
    return _load_doc(dataset_dir / MANIFEST)


def _dataset_id_from_path(path: Path) -> str:
    """Stable uuid5 derived from the resolved folder path."""
    return mint_uuid(f"{RecordType.DATASET}:{path.resolve()}", namespace=uuid.NAMESPACE_DNS)


def _id_from_manifest(manifest: dict[str, Any], path: Path) -> str:
    """Prefer the manifest's ``id`` (validate-on-adopt, v4/v5 only); else mint a
    stable uuid5 from the folder path."""
    return adopt_entity_id(manifest.get("id")) or _dataset_id_from_path(path)


def dataset_id_from_folder(ref: FSRef | Path) -> object | None:
    path = Path(getattr(ref, "_path", ref))
    cap = read_folder_capsule_id(path)
    if cap:
        return cap
    meta, _ = _load_manifest(path)
    return adopt_entity_id(meta.get("id"))


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


# ── IO_FOLDER slot discovery ──────────────────────────────────────────────────

_NO_MATCH = object()


def _slot_id(example_id: str, base: str, index: int | None) -> str:
    """Deterministic per-artifact uuid5; idempotent across re-index."""
    suffix = base if index is None else f"{base}-{index}"
    return mint_uuid(f"{example_id}:{suffix}", namespace=uuid.NAMESPACE_DNS)


def _maybe_text(path: Path) -> str | None:
    """Decode small text artifacts only (.txt/.md). Binary files are never read."""
    if path.suffix.lower() not in TEXT_EXTS:
        return None
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None


def _match_base(stem: str, base: str) -> Any:
    """Classify a dir-entry stem against a slot base.

    ``base`` → bare (``None``); ``f"{base}-{N}"`` (N digits) → ``int(N)``; else
    ``_NO_MATCH``.
    """
    if stem == base:
        return None
    prefix = f"{base}-"
    if stem.startswith(prefix):
        tail = stem[len(prefix):]
        if tail.isdigit():
            return int(tail)
    return _NO_MATCH


def _classify(name: str, is_dir: bool, base: str) -> Any:
    """Return ``("data"|"sidecar", index)`` if ``name`` belongs to ``base``, else
    ``_NO_MATCH``. ``«base»[-N].json`` files are sidecars; folders and non-json
    files are data."""
    stem = name.split(".", 1)[0]
    index = _match_base(stem, base)
    if index is _NO_MATCH:
        return _NO_MATCH
    is_json = (not is_dir) and name.lower().endswith(".json")
    return ("sidecar" if is_json else "data", index)


def _build_artifact(ex_dir: Path, target: Path, index: int | None) -> ExampleArtifact:
    """Wrap one data file/folder as an ExampleArtifact (paths relative, lazy text)."""
    rel = target.relative_to(ex_dir).as_posix()
    if target.is_dir():
        files = sorted(
            p.relative_to(ex_dir).as_posix() for p in target.rglob("*") if p.is_file()
        )
        return ExampleArtifact(kind=ArtifactKind.FOLDER, path=rel, files=files, text=None, index=index)
    return ExampleArtifact(
        kind=ArtifactKind.FILE, path=rel, files=[rel], text=_maybe_text(target), index=index,
    )


def _resolve_ambiguity(a: Path, b: Path) -> Path:
    """Two entries claim one slot+index. File beats folder; ties → lexicographic."""
    a_file, b_file = a.is_file(), b.is_file()
    if a_file and not b_file:
        return a
    if b_file and not a_file:
        return b
    return min(a, b, key=lambda p: p.name)


_Doc = tuple[dict[str, Any], dict[str, Any]]  # a sidecar's (metadata, data) sections


def _assemble_slot(
    ex_dir: Path,
    base: str,
    data: dict[int | None, Path],
    sidecars: dict[int | None, _Doc],
    example_id: str,
) -> ExampleSlot | None:
    """Build one ``ExampleSlot`` from its bucketed data artifacts + sidecars.

    Artifacts are ordered (bare first, then numbered ascending); each consumes
    its matching ``«base»[-N].json`` sidecar (its ``metadata``/``data`` sections).
    A bare sidecar with no data artifact lands at slot level. ``None`` when empty.
    """
    if not data and not sidecars:
        return None
    ordered = sorted(data, key=lambda k: (k is not None, k or 0))
    artifacts: list[ExampleArtifact] = []
    for index in ordered:
        art = _build_artifact(ex_dir, data[index], index)
        art.metadata, art.data = sidecars.pop(index, ({}, {}))  # consume the matching sidecar
        art.id = _slot_id(example_id, base, index)
        artifacts.append(art)
    slot_meta, slot_data = sidecars.get(None, ({}, {}))  # orphan bare sidecar → slot level
    return ExampleSlot(name=base, artifacts=artifacts, metadata=slot_meta, data=slot_data)


def _discover_slots(
    ex_dir: Path, bases: tuple[str, ...], example_id: str
) -> dict[str, ExampleSlot]:
    """Classify a single ``iterdir`` pass into one ``ExampleSlot`` per base.

    Each dir entry belongs to at most one base, so one scan covers every slot —
    far cheaper than re-scanning per base. Returns only bases that have a data
    artifact or sidecar.
    """
    data: dict[str, dict[int | None, Path]] = {b: {} for b in bases}
    sidecars: dict[str, dict[int | None, _Doc]] = {b: {} for b in bases}
    for entry in ex_dir.iterdir():
        is_dir = entry.is_dir()
        for base in bases:
            verdict = _classify(entry.name, is_dir, base)
            if verdict is _NO_MATCH:
                continue
            role, index = verdict
            if role == "sidecar":
                sidecars[base][index] = _load_doc(entry)
            else:
                prev = data[base].get(index)
                data[base][index] = entry if prev is None else _resolve_ambiguity(prev, entry)
            break  # an entry belongs to at most one base
    slots: dict[str, ExampleSlot] = {}
    for base in bases:
        slot = _assemble_slot(ex_dir, base, data[base], sidecars[base], example_id)
        if slot is not None:
            slots[base] = slot
    return slots


def _promote_to_ground_truth(slot: ExampleSlot | None, example_id: str) -> ExampleSlot | None:
    """Re-label a legacy ``expected`` slot as ``ground_truth`` (re-stamp artifact ids)."""
    if slot is None:
        return None
    slot.name = "ground_truth"
    for art in slot.artifacts:
        art.id = _slot_id(example_id, "ground_truth", art.index)
    return slot


def _primary_text(slot: ExampleSlot | None) -> str | None:
    """Text of a slot's primary artifact when it is a text FILE, else None."""
    if slot and slot.primary and slot.primary.kind == ArtifactKind.FILE:
        return slot.primary.text
    return None


def _load_example_meta(ex_dir: Path) -> _Doc:
    """Merge ``meta.json`` (alias) then ``example.json`` (canonical wins).

    Each is a two-section doc; the ``metadata`` and ``data`` sections merge
    independently, with ``example.json`` overriding ``meta.json`` per section.
    """
    metadata: dict[str, Any] = {}
    data: dict[str, Any] = {}
    for fname in (EXAMPLE_META_ALIAS, EXAMPLE_META):
        m, d = _load_doc(ex_dir / fname)
        metadata.update(m)
        data.update(d)
    return metadata, data


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
        example_id = _example_id(dataset_id, ex_dir.name)
        ex_meta, ex_data = _load_example_meta(ex_dir)

        slots = _discover_slots(ex_dir, (*SLOT_BASES, EXPECTED_LEGACY), example_id)
        input_slot = slots.get("input")
        if input_slot is None:
            continue  # no input in any form → not an example (was: no input.txt)

        # Gold = ground_truth; legacy expected.txt folds onto it when absent.
        gt_slot = slots.get("ground_truth") or _promote_to_ground_truth(
            slots.get(EXPECTED_LEGACY), example_id
        )

        rows.append(Example(
            id=example_id,
            kind=_coerce_enum(ex_meta.get("kind"), ExampleKind, ExampleKind.TRAIN),
            input=_primary_text(input_slot) or "",
            expected=_primary_text(gt_slot),  # gold = ground_truth only; output never feeds expected
            metadata=ex_meta,
            data=ex_data,
            input_slot=input_slot,
            output_slot=slots.get("output"),
            ground_truth_slot=gt_slot,
            layout=ex_meta.get("layout"),
        ))
    return rows


# ── extractor ─────────────────────────────────────────────────────────────────

def extract_dataset(ref: FSRef, resolved_id: str) -> list[FSRecord]:
    """Parse a dataset folder into a single FSRecord with denormalized counts."""
    path = ref._path
    if not path.is_dir() or not (path / MANIFEST).is_file():
        return []
    ds_meta, ds_data = _load_manifest(path)

    # Capsule wins (gen_id stamped it), else manifest id, else uuid5(path) — the
    # same precedence as the TypeInfo reader, so direct extraction agrees.
    layout = _coerce_enum(ds_meta.get("data_layout"), DataLayoutEnum, DataLayoutEnum.CSV)
    field_spec = ds_meta.get("field_spec") if isinstance(ds_meta.get("field_spec"), dict) else {}
    delimiter = ds_meta.get("delimiter") or ","
    examples = iter_examples(path, layout, field_spec, delimiter, dataset_id=resolved_id)

    kind_counts: dict[str, int] = {}
    num_annotated = num_multi_output = num_binary_inputs = 0
    for ex in examples:
        kind_counts[ex.kind] = kind_counts.get(ex.kind, 0) + 1
        if ex.ground_truth_slot is not None:
            num_annotated += 1
        if ex.output_slot is not None and len(ex.output_slot.artifacts) > 1:
            num_multi_output += 1
        primary_input = ex.input_slot.primary if ex.input_slot is not None else None
        if primary_input is not None and (
            primary_input.kind == ArtifactKind.FOLDER or primary_input.text is None
        ):
            num_binary_inputs += 1

    name = ds_meta.get("title") or path.name
    description = ds_meta.get("description") if isinstance(ds_meta.get("description"), str) else ""
    content = "\n".join(p for p in (name, description) if p)

    metadata = {
        **ds_meta,  # known dataset fields (incl. `schema`) from the metadata section
        "data_layout": str(layout),
        "field_spec": field_spec,
        "delimiter": delimiter,
        "num_examples": len(examples),
        "kind_counts": kind_counts,
        "num_annotated": num_annotated,
        "num_multi_output": num_multi_output,
        "num_binary_inputs": num_binary_inputs,
        "data": ds_data,  # free dataset-level `data` section (use-case-owned)
    }

    rec_kwargs: dict[str, Any] = {
        "type": RecordType.DATASET,
        "id": resolved_id,
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
