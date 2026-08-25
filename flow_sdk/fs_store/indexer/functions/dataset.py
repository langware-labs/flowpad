"""Extractor + id mint for DATASET records.

A dataset is a folder under ``agentic-assets/dataset/`` containing a ``dataset.json``
manifest (which is also the walker's marker file). The manifest declares the
physical layout; the example rows live beside it:

    agentic-assets/dataset/<slug>/
      dataset.json                 # {"metadata": {id?, data_layout, field_spec, contract, …}, "data": {…}}
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
:class:`~flow_sdk.schema.datum.Datum` tree that MIRRORS the example directory: a
file is a leaf holding its example-relative path, a folder is a branch of its
members, and a sidecar is a sibling leaf keyed by its full filename. Sidecar and
data keys can never collide — a data key is a filename STEM and carries no dot,
a sidecar key always does — which is what lets ``_is_data_key`` be exact.

Nothing here decodes a file: a leaf carries a reference and reading the bytes is
the consumer's job, so a dataset of PDFs stays cheap to index.

Type metadata lives in ``flow_sdk/schema/type_info/dataset_type_info.py``; this
module provides the walker and parser only.
"""
from __future__ import annotations

import csv
import json
import logging
import uuid
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from flow_sdk.builtin.dataset import (
    EXAMPLE_META,  # canonical per-example metadata filename (model-owned)
    DataLayoutEnum,
    Example,
    ExampleKind,
)
from flow_sdk.schema.datum import Datum
from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.identifier import adopt_entity_id, mint_uuid
from flow_sdk.fs_store.indexer.functions._folder_capsule import (
    read_folder_capsule_id,
)
from flow_sdk.fs_store.record_types import RecordType

logger = logging.getLogger(__name__)

MANIFEST = "dataset.json"
CSV_FILE = "data.csv"
EXAMPLES_DIR = "examples"

# IO_FOLDER per-example layout.
INPUT, OUTPUT, GROUND_TRUTH = "input", "output", "ground_truth"
SLOT_BASES = (INPUT, OUTPUT, GROUND_TRUTH)
EXAMPLE_META_ALIAS = "meta.json"       # back-compat alias (example.json wins)
EXPECTED_LEGACY = "expected"           # legacy expected.txt → folded onto ground_truth
TEXT_EXTS = {".txt", ".md"}            # a leaf naming one of these is text, not binary

#: The kind stamped on a leaf whose value is a PATH rather than a literal — the
#: one bit that keeps a leaf self-describing, since an IO_FOLDER leaf references
#: a file while a CSV leaf holds the answer itself. ``content.file`` is the
#: SEEDED ontology kind (``flow_sdk/builtin/tag.py`` SYSTEM_TAG_SEED); minting a
#: private one here would put the vocabulary in two registries, only one of them
#: discoverable.
REF_KIND = "content.file"


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


def _take_contract(ds_meta: dict[str, Any]) -> dict[str, Any] | None:
    """POP the manifest's ``contract`` slot, normalized to a :class:`Datum` dump.

    It is removed from ``ds_meta`` rather than read, because the caller spreads
    that dict into the record metadata — leaving the key behind would publish the
    raw, unvalidated value beside (or instead of) the normalized one.

    Validated here, where the file is still in hand, rather than left raw for a
    consumer to choke on mid-join. ``None`` when absent, not a dict, or
    malformed — a bad contract degrades the SLOT, never the dataset: raising
    would cost every ``Example`` record this extractor also emits, since the
    walk marks only the dataset's own id as seen before parsing, so an
    ``orphan_action=DELETE`` sweep would reap the example rows the contract has
    nothing to do with. (``data_source_spec`` drops its whole record on a bad
    manifest, but there the manifest IS the definition; here the rows parse
    fine.)
    """
    raw = ds_meta.pop("contract", None)
    if not isinstance(raw, dict):
        return None
    try:
        return Datum.model_validate(raw).model_dump(exclude_none=True)
    except ValidationError as exc:
        logger.warning("[dataset] ignoring malformed `contract`: %s", exc)
        return None


def _coerce_enum(value: Any, enum_cls: type, default: Any) -> Any:
    """Map a raw value onto ``enum_cls``, defaulting on absence or invalid value."""
    try:
        return enum_cls(str(value)) if value else default
    except ValueError:
        return default


# ── IO_FOLDER tree assembly ───────────────────────────────────────────────────

_NO_MATCH = object()


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


def _resolve_ambiguity(a: Path, b: Path) -> Path:
    """Two entries claim one slot+index. File beats folder; ties → lexicographic."""
    a_file, b_file = a.is_file(), b.is_file()
    if a_file and not b_file:
        return a
    if b_file and not a_file:
        return b
    return min(a, b, key=lambda p: p.name)


_Doc = tuple[dict[str, Any], dict[str, Any]]  # a two-section doc: (metadata, data)


def _build_datum(ex_dir: Path, target: Path) -> Datum:
    """One data file or folder as a Datum node.

    A file is a LEAF whose value is its example-relative POSIX path; a folder is
    a BRANCH of its members, recursively. That makes the file/folder distinction
    structural rather than a flag, and a folder's contained paths are just its
    leaf values.
    """
    if target.is_dir():
        return Datum(fields={
            child.name: _build_datum(ex_dir, child)
            for child in sorted(target.iterdir(), key=lambda p: p.name)
        })
    return Datum(kind=REF_KIND, value=target.relative_to(ex_dir).as_posix())


def _slot_key(base: str, index: int | None) -> str:
    """The tree key for one occurrence: ``output`` / ``output-2``."""
    return base if index is None else f"{base}-{index}"


def _keys_for(tree: Datum, base: str) -> list[str]:
    """Every DATA occurrence key of ``base``, in canonical order.

    Data and sidecars are told apart by the key alone: at the example root a
    data key is a filename STEM (``_classify`` splits on the first dot, so it
    never carries one) while a sidecar key is a full ``«base»[-N].json``
    filename, which always does. The rule is a root-level one — inside a folder
    branch, members are keyed by full filename and dots are ordinary.
    """
    prefix = f"{base}-"
    return [
        k for k in (tree.fields or {})
        if "." not in k and (k == base or k.startswith(prefix))
    ]


def _build_example_datum(ex_dir: Path) -> Datum:
    """Assemble one example directory into a Datum tree.

    A single ``iterdir`` pass classifies every entry (each belongs to at most one
    base). Data is bucketed by ``(base, index)`` — it has to be, because
    ``_resolve_ambiguity`` needs both candidates in hand and the canonical order
    needs the full set before sorting. Sidecars are not: their emitted key is the
    filename itself, so they only need collecting.

    Data lands under its stem key; a ``«base»[-N].json`` sidecar lands under its
    FULL filename — which can never collide, because a data key is a stem and
    carries no dot while a sidecar key always does.
    """
    bases = (*SLOT_BASES, EXPECTED_LEGACY)
    data: dict[str, dict[int | None, Path]] = {b: {} for b in bases}
    sidecars: list[Path] = []
    for entry in ex_dir.iterdir():
        is_dir = entry.is_dir()
        for base in bases:
            verdict = _classify(entry.name, is_dir, base)
            if verdict is _NO_MATCH:
                continue
            role, index = verdict
            if role == "sidecar":
                sidecars.append(entry)
            else:
                prev = data[base].get(index)
                data[base][index] = entry if prev is None else _resolve_ambiguity(prev, entry)
            break  # an entry belongs to at most one base

    # `expected*` is an ALIAS for ground_truth, honoured only when no native gold
    # DATA exists. A key RENAME at emit time — moving buckets instead would drop
    # any native `ground_truth.json` sidecar.
    alias = EXPECTED_LEGACY if (data[EXPECTED_LEGACY] and not data[GROUND_TRUTH]) else None

    fields: dict[str, Datum] = {}
    # Canonical order per base: bare occurrence first, then numbered ascending.
    # Key ORDER is the only carrier of that ordering, so it is emitted here
    # rather than reconstructed by readers.
    for base in bases:
        if base == EXPECTED_LEGACY and base != alias:
            continue
        emit_as = GROUND_TRUTH if base == alias else base
        for index in sorted(data[base], key=lambda k: (k is not None, k or 0)):
            fields[_slot_key(emit_as, index)] = _build_datum(ex_dir, data[base][index])
    for path in sorted(sidecars, key=lambda p: p.name):
        metadata, doc_data = _load_doc(path)
        fields[path.name] = Datum(value={"metadata": metadata, "data": doc_data})
    return Datum(fields=fields)


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
                cells = {INPUT: Datum(value=raw.get(input_col) or "")}
                if raw.get(expected_col) is not None:
                    cells[GROUND_TRUTH] = Datum(value=raw.get(expected_col))
                rows.append(Example(
                    id=_example_id(dataset_id, str(i)),
                    kind=_coerce_enum(raw.get(kind_col), ExampleKind, ExampleKind.TRAIN),
                    metadata={k: v for k, v in raw.items() if k not in consumed},
                    datum=Datum(fields=cells),
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

        tree = _build_example_datum(ex_dir)
        if not _keys_for(tree, INPUT):
            continue  # no input DATA in any form → not an example (a lone sidecar is not an input)

        rows.append(Example(
            id=example_id,
            kind=_coerce_enum(ex_meta.get("kind"), ExampleKind, ExampleKind.TRAIN),
            metadata=ex_meta,
            data=ex_data,
            datum=tree,
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
        tree = ex.datum
        # "Annotated" means real gold DATA — a lone `ground_truth.json` sidecar is
        # metadata ABOUT gold, not gold.
        if _keys_for(tree, GROUND_TRUTH):
            num_annotated += 1
        if len(_keys_for(tree, OUTPUT)) > 1:
            num_multi_output += 1
        inputs = _keys_for(tree, INPUT)
        primary = tree.fields[inputs[0]] if inputs else None
        if primary is not None and (
            not primary.is_leaf or Path(str(primary.value)).suffix.lower() not in TEXT_EXTS
        ):
            num_binary_inputs += 1

    name = ds_meta.get("title") or path.name
    description = ds_meta.get("description") if isinstance(ds_meta.get("description"), str) else ""
    content = "\n".join(p for p in (name, description) if p)

    contract = _take_contract(ds_meta)  # POPS the raw key before the spread below

    metadata = {
        **ds_meta,  # known dataset fields from the metadata section
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
    if contract is not None:
        metadata["contract"] = contract   # absent ⇒ the dataset declares no shape

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
