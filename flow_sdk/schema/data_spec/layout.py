"""``DatasetLayout`` — the ONE thing that knows how examples sit on disk.

``ExampleSpec`` is a value; it never learns whether it came from a CSV row or a
folder of files. A layout does: ``read(folder, spec)`` turns the disk into
typed rows and ``write(folder, examples)`` turns rows back into the disk. Two
layouts, one on-disk grammar each — and the grammar is UNCHANGED from the
walker this replaces (its 74 tests are the spec).

Lives in ``data_spec``, not beside the indexer walker: the ``Dataset`` entity
and the graph-workflow capture seam both call it, and neither may import the
indexer package (that is the cycle ``_kinds.py`` guards against).
"""

from __future__ import annotations

import csv
import json
import shutil
import uuid
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, ClassVar, Optional, Sequence, Union

from flow_sdk.schema.data_spec.dataset_spec import (
    DataLayoutEnum,
    ExampleKind,
    ExampleSpec,
    FileRef,
    FolderSpec,
    TextSpec,
)

CSV_FILE = "data.csv"
EXAMPLES_DIR = "examples"
EXAMPLE_META = "example.json"
EXAMPLE_META_ALIAS = "meta.json"       # back-compat alias (example.json wins)

# IO_FOLDER per-example grammar.
INPUT, OUTPUT, GROUND_TRUTH, CONTEXT = "input", "output", "ground_truth", "context"
SLOT_BASES = (INPUT, OUTPUT, GROUND_TRUTH, CONTEXT)
EXPECTED_LEGACY = "expected"           # legacy expected.txt → folded onto ground_truth
TEXT_EXTS = {".txt", ".md"}            # a file naming one of these is text, not binary

_Doc = tuple[dict[str, Any], dict[str, Any]]  # a two-section doc: (metadata, data)


# ── shared helpers ────────────────────────────────────────────────────────────

@lru_cache(maxsize=4096)
def example_id(dataset_id: str, key: str) -> str:
    """Deterministic per-example id of ``f"{dataset_id}:{key}"``.

    A uuid5 — kept EXACTLY (three tests hard-code the formula; changing it is a
    data migration). The row index for CSV, the example folder name for IO_FOLDER.
    """
    from flow_sdk.fs_store.identifier import mint_uuid  # noqa: PLC0415

    return mint_uuid(f"{dataset_id}:{key}", namespace=uuid.NAMESPACE_DNS)


def coerce_dataset_enum(value: Any, enum_cls: type, default: Any) -> Any:
    """Map a raw value onto ``enum_cls``, defaulting on absence or invalid value."""
    try:
        return enum_cls(str(value)) if value else default
    except ValueError:
        return default


def load_json_dict(path: Path) -> dict[str, Any]:
    """Read a JSON object from ``path``; ``{}`` when absent, malformed, or non-dict."""
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return loaded if isinstance(loaded, dict) else {}


def load_doc(path: Path) -> _Doc:
    """Read a two-section dataset JSON → ``(metadata, data)``; each ``{}`` when
    absent or non-dict. A flat doc yields ``({}, {})`` — the structure is mandatory."""
    obj = load_json_dict(path)
    meta, data = obj.get("metadata"), obj.get("data")
    return (meta if isinstance(meta, dict) else {}, data if isinstance(data, dict) else {})


def write_doc(path: Path, metadata: dict[str, Any], data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"metadata": metadata, "data": data}, indent=2, default=str) + "\n", encoding="utf-8")


def is_binary(node: Any) -> bool:
    """A folder is binary by definition; a file is binary unless its extension
    says text; a literal is text."""
    if isinstance(node, FolderSpec):
        return True
    if isinstance(node, FileRef):
        return Path(node.path).suffix.lower() not in TEXT_EXTS
    return False


# ── base ──────────────────────────────────────────────────────────────────────

class DatasetLayout:
    name: ClassVar[str] = ""

    # Per-example writes exist only where an example is a directory of its own;
    # a CSV is rewritten whole, so the base refuses and only FolderLayout answers.
    def append(self, folder, ex: ExampleSpec, *, dataset_id: str, contents: Optional[dict[str, Any]] = None) -> str:
        raise NotImplementedError("append is io_folder only — a CSV dataset is rewritten whole")

    def append_many(self, folder, rows: "Sequence[tuple]", *, dataset_id: str) -> list[str]:
        raise NotImplementedError("append is io_folder only — a CSV dataset is rewritten whole")

    def annotate(self, folder, example_id_: str, ground_truth: Any, *, dataset_id: str, by: str = "") -> Path:
        raise NotImplementedError("annotate is io_folder only — a CSV dataset is rewritten whole")

    def index(self, folder, *, dataset_id: str) -> list[dict[str, Any]]:
        """Per-example scalars (id, source item, kind, gold present) without
        reading the payloads. Only a per-example layout can answer."""
        raise NotImplementedError("index is io_folder only — a CSV dataset has no per-example dirs")

    def read(self, folder: Path, spec: type, *, dataset_id: str,
             field_spec: Optional[dict[str, str]] = None, delimiter: str = ",") -> list[Any]:
        raise NotImplementedError

    def write(self, folder: Path, examples: Sequence[ExampleSpec], *, dataset_id: str,
              field_spec: Optional[dict[str, str]] = None, delimiter: str = ",",
              source: Optional[Path] = None) -> None:
        raise NotImplementedError


def layout_for(name: Union[str, DataLayoutEnum]) -> DatasetLayout:
    layout = coerce_dataset_enum(name, DataLayoutEnum, DataLayoutEnum.CSV)
    return FolderLayout() if layout == DataLayoutEnum.IO_FOLDER else CsvLayout()


# ── CSV ───────────────────────────────────────────────────────────────────────

def _cols(field_spec: Optional[dict[str, str]]) -> tuple[str, str, str]:
    """``(input, expected, kind)`` column names, mapped through ``field_spec``."""
    fs = field_spec or {}
    return fs.get("input", "input"), fs.get("expected", "expected"), fs.get("kind", "kind")


class CsvLayout(DatasetLayout):
    """``data.csv`` — one row per example; cells are ``TextSpec`` literals.

    ``field_spec`` maps a canonical name to the actual column, e.g.
    ``{"input": "question", "expected": "answer"}``. Leftover columns land in
    ``metadata``.
    """

    name = DataLayoutEnum.CSV.value

    def read(self, folder, spec, *, dataset_id, field_spec=None, delimiter=","):
        csv_path = Path(folder) / CSV_FILE
        if not csv_path.is_file():
            return []
        input_col, expected_col, kind_col = _cols(field_spec)
        consumed = {input_col, expected_col, kind_col}
        rows = []
        with csv_path.open(newline="", encoding="utf-8") as fh:
            for i, raw in enumerate(csv.DictReader(fh, delimiter=delimiter or ",")):
                row: dict[str, Any] = {
                    "id": example_id(dataset_id, str(i)),
                    "kind": coerce_dataset_enum(raw.get(kind_col), ExampleKind, ExampleKind.TRAIN),
                    "input": TextSpec(text=raw.get(input_col) or ""),
                    "metadata": {k: v for k, v in raw.items() if k not in consumed},
                }
                if raw.get(expected_col) is not None:
                    row["ground_truth"] = TextSpec(text=raw.get(expected_col))
                rows.append(spec.model_validate(row))
        return rows

    def write(self, folder, examples, *, dataset_id, field_spec=None, delimiter=",", source=None):
        input_col, expected_col, kind_col = _cols(field_spec)
        extra = sorted({k for ex in examples for k in ex.metadata})
        folder = Path(folder)
        folder.mkdir(parents=True, exist_ok=True)
        with (folder / CSV_FILE).open("w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=[kind_col, input_col, expected_col, *extra], delimiter=delimiter or ",")
            w.writeheader()
            for ex in examples:
                gt = ex.ground_truth
                w.writerow({
                    kind_col: ex.kind.value,
                    input_col: _cell(ex.input),
                    expected_col: _cell(gt) if gt is not None else "",
                    **{k: ex.metadata.get(k, "") for k in extra},
                })


def _cell(node: Any) -> str:
    if isinstance(node, TextSpec):
        return node.text
    raise ValueError(f"csv layout holds text slots only; got {type(node).__name__}")


# ── IO_FOLDER ─────────────────────────────────────────────────────────────────

_NO_MATCH = object()


def _match_base(stem: str, base: str) -> Any:
    """``base`` → bare (``None``); ``f"{base}-{N}"`` (N digits) → ``int(N)``; else ``_NO_MATCH``."""
    if stem == base:
        return None
    prefix = f"{base}-"
    if stem.startswith(prefix):
        tail = stem[len(prefix):]
        if tail.isdigit():
            return int(tail)
    return _NO_MATCH


def _classify(name: str, is_dir: bool, base: str) -> Any:
    """``("data"|"sidecar", index)`` if ``name`` belongs to ``base``, else ``_NO_MATCH``.
    ``«base»[-N].json`` files are sidecars; folders and non-json files are data."""
    stem = name.split(".", 1)[0]
    index = _match_base(stem, base)
    if index is _NO_MATCH:
        return _NO_MATCH
    is_json = (not is_dir) and name.lower().endswith(".json")
    return ("sidecar" if is_json else "data", index)


def occurrence_key(node: Any, base: str) -> str:
    """The on-disk occurrence key (``output`` / ``output-2``) of a slot value.

    Derived from the artifact's own path — the filename IS the key — with the
    legacy ``expected*`` alias folded onto ``ground_truth`` exactly as the reader
    emits it. A ``TextSpec`` (a CSV cell) has no path and no occurrences.
    """
    path = getattr(node, "path", None)
    if not path:
        return base
    stem = Path(path).name.split(".", 1)[0]
    if stem.startswith(EXPECTED_LEGACY):
        return GROUND_TRUTH + stem[len(EXPECTED_LEGACY):]
    return stem


def is_sidecar_name(name: str) -> bool:
    """Is ``name`` a ``«base»[-N].json`` sidecar filename for any slot base?"""
    for base in (*SLOT_BASES, EXPECTED_LEGACY):
        verdict = _classify(name, False, base)
        if verdict is not _NO_MATCH and verdict[0] == "sidecar":
            return True
    return False


def _resolve_ambiguity(a: Path, b: Path) -> Path:
    """Two entries claim one slot+index. File beats folder; ties → lexicographic."""
    a_file, b_file = a.is_file(), b.is_file()
    if a_file and not b_file:
        return a
    if b_file and not a_file:
        return b
    return min(a, b, key=lambda p: p.name)


def _build_node(ex_dir: Path, target: Path) -> Union[FileRef, FolderSpec]:
    """A file is a ``FileRef`` (its example-relative POSIX path); a folder is a
    ``FolderSpec`` of its members, recursively. Bytes are never read."""
    rel = target.relative_to(ex_dir).as_posix()
    if target.is_dir():
        return FolderSpec(path=rel, files={
            child.name: _build_node(ex_dir, child)
            for child in sorted(target.iterdir(), key=lambda p: p.name)
        })
    return FileRef(path=rel)


def _load_example_meta(ex_dir: Path) -> _Doc:
    """``meta.json`` (alias) then ``example.json`` (canonical wins), merged per section."""
    metadata: dict[str, Any] = {}
    data: dict[str, Any] = {}
    for fname in (EXAMPLE_META_ALIAS, EXAMPLE_META):
        m, d = load_doc(ex_dir / fname)
        metadata.update(m)
        data.update(d)
    return metadata, data


def _example_dirs(folder) -> list[Path]:
    """The example directories of a dataset folder, in name order. The ONE
    enumeration — `read`, `index` and `example_dir` all walk through here."""
    examples_dir = Path(folder) / EXAMPLES_DIR
    if not examples_dir.is_dir():
        return []
    return sorted((p for p in examples_dir.iterdir() if p.is_dir()), key=lambda p: p.name)


class FolderLayout(DatasetLayout):
    """``examples/<name>/`` — slots are files or folders; sidecars annotate them."""

    name = DataLayoutEnum.IO_FOLDER.value

    def read(self, folder, spec, *, dataset_id, field_spec=None, delimiter=","):
        rows = []
        for ex_dir in _example_dirs(folder):
            row = self.read_example(ex_dir)
            if row is None:
                continue  # no input DATA in any form → not an example
            row["id"] = example_id(dataset_id, ex_dir.name)
            rows.append(spec.model_validate(row))
        return rows

    def read_example(self, ex_dir: Path) -> Optional[dict[str, Any]]:
        """One example directory as a row dict — ``None`` when it has no input data.

        A single ``iterdir`` pass classifies every entry (each belongs to at most
        one base). Data is bucketed by ``(base, index)``; sidecars only collected.
        """
        bases = (*SLOT_BASES, EXPECTED_LEGACY)
        data: dict[str, dict[Optional[int], Path]] = {b: {} for b in bases}
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
                break
        if not data[INPUT]:
            return None

        # `expected*` is an ALIAS for ground_truth, honoured only when no native
        # gold DATA exists — a rename at emit time, so a native `ground_truth.json`
        # sidecar is never dropped.
        alias = EXPECTED_LEGACY if (data[EXPECTED_LEGACY] and not data[GROUND_TRUTH]) else None

        ex_meta, ex_data = _load_example_meta(ex_dir)
        row: dict[str, Any] = {
            "kind": coerce_dataset_enum(ex_meta.get("kind"), ExampleKind, ExampleKind.TRAIN),
            "metadata": dict(ex_meta),
            "data": ex_data,
        }
        for base in (*SLOT_BASES, *([EXPECTED_LEGACY] if alias else [])):
            if not data[base]:
                continue
            emit_as = GROUND_TRUTH if base == alias else base
            # Canonical order: bare occurrence first, then numbered ascending.
            ordered = [_build_node(ex_dir, data[base][i])
                       for i in sorted(data[base], key=lambda k: (k is not None, k or 0))]
            # A sole BARE occurrence is the value itself; any numbering makes a list.
            row[emit_as] = ordered[0] if list(data[base]) == [None] else ordered
        # Sidecars ride in metadata under their FULL filename — never colliding
        # with example.json keys (those carry no dot), and legal as orphans.
        for path in sorted(sidecars, key=lambda p: p.name):
            m, d = load_doc(path)
            row["metadata"][path.name] = {"metadata": m, "data": d}
        return row

    def resolve(self, example_dir: Path, ref: Union[FileRef, FolderSpec]) -> Path:
        """The only place a ``FileRef`` becomes an absolute path."""
        return Path(example_dir) / ref.path

    def write(self, folder, examples, *, dataset_id, field_spec=None, delimiter=",", source=None):
        folder = Path(folder)
        (folder / EXAMPLES_DIR).mkdir(parents=True, exist_ok=True)
        for i, ex in enumerate(examples, 1):
            name = f"{i:04d}"
            self.write_example(folder / EXAMPLES_DIR / name, ex,
                               source=(Path(source) / EXAMPLES_DIR / name) if source else None)

    # ── one example at a time ────────────────────────────────────────────────

    def append(self, folder, ex: ExampleSpec, *, dataset_id: str,
               contents: Optional[dict[str, Any]] = None) -> str:
        """Add ONE example without rewriting the others. Returns its id (the
        pinned ``example_id`` formula over the dir name, so a later ``read``
        agrees)."""
        (ids,) = self.append_many(folder, [(ex, contents)], dataset_id=dataset_id)
        return ids

    def append_many(self, folder, rows: Sequence[tuple], *, dataset_id: str) -> list[str]:
        """Append a batch: ONE directory scan for the whole batch, then a dir
        per row (``rows`` is ``(example, contents)`` pairs). Numbering follows
        the highest existing ``NNNN``, never the count, so a gap is preserved."""
        examples_dir = Path(folder) / EXAMPLES_DIR
        examples_dir.mkdir(parents=True, exist_ok=True)
        taken = [int(p.name) for p in examples_dir.iterdir() if p.is_dir() and p.name.isdigit()]
        nxt = (max(taken) + 1) if taken else 1
        ids = []
        for offset, (ex, contents) in enumerate(rows):
            name = f"{nxt + offset:04d}"
            self.write_example(examples_dir / name, ex, contents=contents)
            ids.append(example_id(dataset_id, name))
        return ids

    def index(self, folder, *, dataset_id: str) -> list[dict[str, Any]]:
        """The rows as scalars — id, source item, kind, gold present — reading
        only ``example.json`` and one ``exists`` per dir (never the payloads)."""
        out = []
        for ex_dir in _example_dirs(folder):
            meta, _ = _load_example_meta(ex_dir)
            out.append({
                "example_id": example_id(dataset_id, ex_dir.name),
                "item_id": (meta.get("source") or {}).get("item_id"),
                "kind": str(coerce_dataset_enum(meta.get("kind"), ExampleKind, ExampleKind.TRAIN).value),
                "annotated": (ex_dir / GROUND_TRUTH).exists(),
            })
        return out

    def example_dir(self, folder, example_id_: str, *, dataset_id: str) -> Optional[Path]:
        """The directory behind an example id, or None. Ids are a pure (cached)
        function of ``(dataset_id, dir name)``, so this is a scan, never a
        lookup table."""
        return next((p for p in _example_dirs(folder) if example_id(dataset_id, p.name) == example_id_), None)

    def annotate(self, folder, example_id_: str, ground_truth: Any, *, dataset_id: str, by: str = "") -> Path:
        """Write the gold answer of one example — ``ground_truth/label.json`` —
        and record who did it in ``example.json`` (``metadata.annotations``).
        A folder slot, so the layout reads it back as data (a bare ``.json`` at
        slot level is a sidecar by the classification rule above)."""
        ex_dir = self.example_dir(folder, example_id_, dataset_id=dataset_id)
        if ex_dir is None:
            raise LookupError(f"no example {example_id_} in {folder}")
        node = FolderSpec(path=GROUND_TRUTH, files={"label.json": FileRef(path=f"{GROUND_TRUTH}/label.json")})
        self._write_node(ex_dir, None, node, {f"{GROUND_TRUTH}/label.json": ground_truth}, None)
        metadata, data = _load_example_meta(ex_dir)
        annotations = list(metadata.get("annotations") or [])
        annotations.append({"by": by, "at": datetime.now(timezone.utc).isoformat()})
        metadata["annotations"] = annotations
        self.write_example_meta(ex_dir, metadata, data)
        return ex_dir

    def write_example(self, ex_dir: Path, ex: ExampleSpec, *, contents: Optional[dict[str, Any]] = None,
                      source: Optional[Path] = None, stamp: bool = True) -> None:
        """The primitive: one example into one directory. ``contents`` supplies
        file bytes/JSON by relative path; else ``source`` is copied; else empty."""
        ex_dir = Path(ex_dir)
        ex_dir.mkdir(parents=True, exist_ok=True)
        contents = contents or {}
        for base in SLOT_BASES:
            value = getattr(ex, base, None)
            if value is None:
                continue
            nodes = value if isinstance(value, list) else [value]
            for n, node in enumerate(nodes, 1):
                slot = base if not isinstance(value, list) else f"{base}-{n}"
                self._write_node(ex_dir, slot, node, contents, source)
        meta = dict(ex.metadata)
        for key in list(meta):
            if is_sidecar_name(key):
                sc = meta.pop(key)
                if isinstance(sc, dict):
                    write_doc(ex_dir / key, sc.get("metadata") or {}, sc.get("data") or {})
        if stamp:
            self.write_example_meta(ex_dir, {**meta, "kind": ex.kind.value}, ex.data)

    def write_example_meta(self, ex_dir: Path, metadata: dict[str, Any], data: Optional[dict[str, Any]] = None) -> None:
        """``example.json`` — the ONE writer."""
        write_doc(Path(ex_dir) / EXAMPLE_META, metadata, data or {})

    def _write_node(self, ex_dir: Path, slot: Optional[str], node: Any, contents: dict, source: Optional[Path]) -> None:
        """``slot`` names a TEXT cell's file only; artifacts carry their own path."""
        if isinstance(node, TextSpec):
            if slot is None:
                raise ValueError("a text cell cannot be a folder member — it has no path")
            (ex_dir / f"{slot}.txt").write_text(node.text, encoding="utf-8")
            return
        if isinstance(node, FolderSpec):
            (ex_dir / node.path).mkdir(parents=True, exist_ok=True)
            for member in node.files.values():
                self._write_node(ex_dir, None, member, contents, source)   # members carry their own paths
            return
        if isinstance(node, FileRef):
            target = ex_dir / node.path
            target.parent.mkdir(parents=True, exist_ok=True)
            if node.path in contents:
                payload = contents[node.path]
                if isinstance(payload, (bytes, bytearray)):
                    target.write_bytes(payload)
                elif isinstance(payload, str):
                    target.write_text(payload, encoding="utf-8")
                else:
                    target.write_text(json.dumps(payload, indent=2, default=str) + "\n", encoding="utf-8")
            elif source is not None and (source / node.path).is_file():
                shutil.copyfile(source / node.path, target)
            elif not target.exists():
                target.touch()
            return
        raise ValueError(f"cannot write a {type(node).__name__} slot")
