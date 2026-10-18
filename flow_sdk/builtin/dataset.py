"""``Dataset`` — a folder-backed collection of rows for eval & training.

A dataset holds many ``Row`` rows in one of two physical layouts (see
``DataLayoutEnum``):

- ``CSV``        — a single ``data.csv`` file; each row is a row.
- ``IO_FOLDER``  — an ``rows/`` folder where each row dir carries
  ``input`` / ``output`` / ``ground_truth`` slots (file, folder, or numbered
  occurrences) plus ``«slot».json`` metadata sidecars and an ``row.json``.
  Legacy ``input.txt`` / ``expected.txt`` are still accepted.

Either layout parses into the same shape: one ``RowSpec`` row per row
whose slots are artifacts — a ``FileRef`` (a row-relative path), a
``FolderSpec`` (its members, recursively), or a ``TextSpec`` (a CSV cell) — and
whose sidecars ride in ``metadata`` under their full filename. Nothing here holds
file CONTENTS; the layout resolves a ref to bytes when a consumer asks. The
dataset ``spec`` (a :class:`DatasetSpec` parametrization) types the slots.

Every dataset JSON file (``dataset.json``, ``row.json``, ``«slot».json``) is a
two-section document — ``{"metadata": {...}, "data": {...}}``. ``metadata`` holds
flowpad-managed known fields (parsed into typed attributes); ``data`` is a free
object the use case owns. Both are surfaced on the carrier models below.

The container is the entity; an ``Row`` is a plain Pydantic row parsed from
disk on demand (a 50k-row CSV stays one record, not 50k entities). The
train/eval/test split lives *per-row* as ``Row.kind`` — "the eval set"
is simply ``dataset.rows(RowKind.EVAL)``.

The on-disk grammar (both layouts, per-row reads and writes, the index)
lives in ``flow_sdk/schema/data_spec/layout.py``; the indexer's extractor and
id mint in ``flow_sdk/fs_store/indexer/functions/dataset.py``; the type
registration in ``flow_sdk/schema/type_info/dataset_type_info.py``.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from pathlib import Path
from typing import Any, ClassVar, Dict, List, Optional

from pydantic import ValidationError, model_validator

from flow_sdk.api.api_types.api_field import APIField, NoDBAPIField, Persist, Sharing
from flow_sdk.core import Entity, action
from flow_sdk.datasets.projection import ROW_KEY, delete_through, is_link, write_through
from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp
from flow_sdk.request_context.json_body import current_user_id, read_json_body
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse
from flow_sdk.schema.data_spec._form import ShapeForm
from flow_sdk.schema.data_spec.dataset_manifest_spec import DatasetManifestSpec
from flow_sdk.schema.data_spec.dataset_spec import (  # noqa: F401 — enums re-exported
    DEFAULT_DATASET_SPEC,
    DataLayoutEnum,
    DatasetSpec,
    RowKind,
    RowSpec,
)

# Canonical per-row metadata filename inside an IO_FOLDER row dir.
# Owned here (the model module) so writers (GraphWorkflowManager's born-compatible
# row stamps) and the indexer's reader agree by construction.
from flow_sdk.schema.data_spec.layout import ROW_META, ROWS_DIR  # noqa: F401 — re-exported
from flow_sdk.stream_inbox._locks import keyed_loop_lock, new_registry

#: What `rows` holds: paths, folders and cells — never file CONTENTS.
ARTIFACT_ROW = DEFAULT_DATASET_SPEC.row_type()
# The manifest — also the repo walker's marker for "this folder is a dataset".
MANIFEST = "dataset.json"

logger = logging.getLogger(__name__)
# One write at a time per dataset while it goes out to the system that owns it (``Dataset._writing``).
_WRITING = new_registry()


def _pairs(rows: Any) -> list[tuple[Optional[str], dict]]:
    """Rows as ``(key, row)`` for the write-through -- the key None for a row not named yet; a value
    that is not a list of rows gives none (the write itself then says what is wrong with it)."""
    return [(r.get("key") if isinstance(r, dict) else None, r) for r in rows] if isinstance(rows, list) else []


# Re-exported: the enums live with the value models.
__all__ = ["ConflictError", "Dataset", "DatasetManifestSpec", "LinkError", "RowRefused", "DataLayoutEnum", "RowKind", "RowSpec", "ROW_META", "MANIFEST"]


#: A field that holds a DATASET shape — ``DatasetSpec.parse`` reads the keyword
#: form; the shared ``to_authoring_form`` emits it back (the parametrization
#: remembers its form). STRICT: a malformed spec on an API write is a 4xx, not
#: a silent None. Leniency is a DISK-READ policy and lives in ``from_fs``.





def _raw_input(shape: Any, ex_dir: Path) -> Any:
    """A row's ``input`` as stored, unchecked -- what a problem report shows. None when unreadable."""
    from flow_sdk.schema.data_spec.io.reader import read_fields  # noqa: PLC0415

    spec = shape.typed.get("input")
    if spec is None or not (ex_dir / "input" / shape.mains["input"]).is_file():
        return None
    try:
        return read_fields(spec, ex_dir / "input")
    except Exception:  # noqa: BLE001 -- a report of a broken row never breaks itself
        return None


class LinkError(ValueError):
    """A row's references do not hold: one names a row that does not exist, a rule across rows is
    broken, or a delete would leave another row pointing at nothing. ``errors`` lists each as a line,
    like a shape error; ``details`` as ``{path, code, message}``."""

    def __init__(self, details: list[dict]):
        from flow_sdk.datasets.links import detail_lines  # noqa: PLC0415

        self.details = list(details)
        self.errors = detail_lines(self.details)
        super().__init__("; ".join(self.errors))


#: The name for what ``LinkError`` has grown into: any refusal of a row that is not "changed since"
#: -- a reference that names nothing, a rule, a ``unique`` value, an ``owned`` field, a shape
#: (in a batch). Read ``details[].code``; catch either name.
RowRefused = LinkError


class ConflictError(ValueError):
    """``put / delete_row / rename_row(expected=...)``: the row changed since the version the caller
    read (``code`` ``"conflict"``), or is gone since (``"gone"``)."""

    def __init__(self, message: str, code: str = "conflict"):
        super().__init__(message)
        self.errors = [message]
        self.details = [{"path": "", "code": code, "message": message}]


def _put_details(exc: ValidationError, row: Any, dataset: "Dataset") -> list[dict]:
    """A put refused for its shape: the shape's details (from the error at hand -- not validated
    again) and the row's broken references, in one answer."""
    from flow_sdk.datasets.links import shape_details  # noqa: PLC0415

    return shape_details(exc) + (dataset._raw_link_details(row) if dataset.asset_ref else [])


def _misfit(exc: ValidationError, row: Any, dataset: "Dataset", message: str) -> ApiFailResponse:
    """A row refused for its SHAPE, answered like every other refusal: ``errors`` as lines and
    ``details`` as ``{path, code, message}`` (the row's broken references in the same answer)."""
    from flow_sdk.datasets.links import detail_lines  # noqa: PLC0415

    details = _put_details(exc, row, dataset)
    return ApiFailResponse(message=message, status_code=400, data={"errors": detail_lines(details), "details": details})


def _written(data: dict, warnings: list[dict]) -> ApiSuccessResponse:
    """A row write's answer. ``warnings`` (a record the outside system made but not all of) ride
    INSIDE ``data`` as well as on the envelope: the SDK hands a caller ``data`` alone."""
    if warnings:
        return ApiSuccessResponse(data={**data, "warnings": warnings}, warnings=warnings)
    return ApiSuccessResponse(data=data)


def _refused(exc: "LinkError | ConflictError", status_code: int) -> ApiFailResponse:
    """A refused row write as the API answers it: the message, its lines and its details."""
    return ApiFailResponse(message=str(exc), status_code=status_code, data={"errors": exc.errors, "details": exc.details})


class Dataset(Entity):
    """A dataset folder — the ROW. Its shape on disk is ``DatasetManifestSpec``
    (``TypeInfo.asset_spec``); where ``dataset.json`` lands and how the rows
    are laid out is the disk serializer's, driven by ``TypeInfo``
    (``main_file``, ``rows_layout_field``)."""

    type: str = APIField(default="dataset")
    title: str = APIField("")
    description: Optional[str] = APIField(None, blob=True)
    # The DataSource this dataset curates: its items are promoted into rows
    # (`promote`) and labelled (`annotate`). One source may feed many datasets.
    source_id: str = APIField("")

    # Physical layout discriminator + CSV-only knobs.
    data_layout: DataLayoutEnum = APIField(DataLayoutEnum.CSV)
    # Column mapping so an arbitrary CSV maps onto the canonical slots without
    # reshaping the file: {"input": "question", "expected": "answer"}.
    field_spec: Dict[str, str] = APIField({})
    delimiter: str = APIField(",")

    # The shape every row has. `None` — the dataset declares no shape — is legal
    # and validates rows against DEFAULT_DATASET_SPEC. See datasets.md.
    spec: Optional[ShapeForm] = APIField(None)

    # The rows. EAGER — `from_fs` reads them all — but DB-excluded: the record
    # file and `from_fs_ref` carry them, the SQLite row does not.
    rows: List[ARTIFACT_ROW] = NoDBAPIField(default_factory=list, sharing=Sharing.PRIVATE, persist=Persist.TRUE)  # type: ignore[valid-type]

    # Denormalized counts surfaced in lists — computed from the rows by the
    # entity (num_rows/kind_counts) and by the indexer (the other three).
    # Persist.TRUE: they ride the shadow index so `from_record` lifts them onto
    # the DB row; they are NOT header fields, so the manifest never carries them.
    num_rows: int = APIField(0, persist=Persist.TRUE)
    kind_counts: Dict[str, int] = APIField({}, persist=Persist.TRUE)
    num_annotated: int = APIField(0, persist=Persist.TRUE)
    num_multi_output: int = APIField(0, persist=Persist.TRUE)
    num_binary_inputs: int = APIField(0, persist=Persist.TRUE)

    # Free `data` section of dataset.json (use-case-owned passthrough).
    data: Optional[Dict[str, Any]] = APIField(default_factory=dict, persist=Persist.TRUE)

    created_at: Optional[datetime] = APIField(None)

    # Absolute path of the dataset folder on disk, stamped by the indexer /
    # ``Entity.from_fs_ref``. A plain string, not an FSRef. Mirrors CHART.
    asset_ref: str = APIField(default="", sharing=Sharing.PRIVATE)

    @model_validator(mode="after")
    def _counts_follow_the_rows(self) -> "Dataset":
        """``num_rows`` / ``kind_counts`` are FACTS about ``rows`` —
        derived here, so an entity built from rows (a save) and one read from
        disk agree, and neither can carry a stale count."""
        if self.rows:
            from flow_sdk.assets.types.dataset import dataset_counts

            counts = dataset_counts(str(row.kind) for row in self.rows)
            self.num_rows = counts["num_rows"]
            self.kind_counts = counts["kind_counts"]
        return self

    def of_kind(self, kind: RowKind) -> List[RowSpec]:
        """'The eval set' is ``dataset.of_kind(RowKind.EVAL)``."""
        return [e for e in self.rows if e.kind == kind]

    # ── the curation seam: SourceItem → row → gold ───────────────────

    def _dataset_type(self) -> Any:
        """The declared row shape, compiled.

        ``spec`` holds the authoring FORM (it is a document field, so it is
        data); a class is built only here, where one is actually needed.
        ``DatasetSpec.parse`` rather than ``DataSpec.parse`` — a dataset form
        names ``rows``, not fields.
        """
        return DatasetSpec.parse(self.spec) if self.spec else DEFAULT_DATASET_SPEC

    @property
    def input_shape(self) -> Any:
        return self._dataset_type().row_type().input_type()

    @property
    def output_shape(self) -> Any:
        return self._dataset_type().row_type().output_type()

    @property
    def declared_kind(self) -> str:
        """The kind this dataset says it is (``navigator.dataset``) -- ``""`` for an inline shape."""
        return self.spec if isinstance(self.spec, str) else ""

    def _folder(self) -> Path:
        if not self.asset_ref:
            raise ValueError("dataset has no folder on disk yet")
        return Path(self.asset_ref)

    def _index(self) -> List[Dict[str, Any]]:
        """Per-row scalars from the folder — the cheap read (one
        ``row.json`` per dir), never the typed payloads."""
        from flow_sdk.schema.data_spec.layout import dataset_layout_for  # noqa: PLC0415

        if self.data_layout != DataLayoutEnum.IO_FOLDER or not self.asset_ref:
            return []
        return dataset_layout_for(self.data_layout).index(self._folder(), dataset_id=self.id)

    async def refresh_counts(self) -> "Dataset":
        """Re-derive the denormalized counts after a per-row write (the
        actions here, or a caller that appended rows itself), and broadcast the row. A write changes only the counts, and those follow
        from the cheap index — re-parsing every row's payload (what a full
        reindex does) would make labelling N rows O(N²)."""
        rows = self._index()
        from flow_sdk.assets.types.dataset import dataset_counts

        counts = dataset_counts(row["kind"] for row in rows)
        self.num_rows = counts["num_rows"]
        # `annotated` is the layout's `has_ground_truth` — the rule the indexer's
        # `count_annotated` applies too, so a label and a reindex agree.
        self.num_annotated = sum(1 for row in rows if row["annotated"])
        self.kind_counts = counts["kind_counts"]
        await self.save()
        return self

    @action.get(action_name="row-index")
    async def row_index_action(self):
        """The rows as the disk holds them — id, the source item behind each,
        and whether it carries gold. What an editor needs to show promoted /
        labelled state without the DB-excluded ``rows`` field."""
        return ApiSuccessResponse(data={"rows": self._index()})

    async def promote(self, item_ids: list[str]) -> list[str]:
        """Items → row rows (``input/item.json`` + provenance). Returns the
        new row ids. Raises ``LookupError`` for an unknown item,
        ``ValueError`` when the dataset cannot take source items."""
        from flow_sdk.builtin.source_item import SourceItem
        from flow_sdk.schema.data_spec.dataset_spec import FileRef, FolderSpec  # noqa: PLC0415
        from flow_sdk.schema.data_spec.layout import INPUT, dataset_layout_for  # noqa: PLC0415
        from flow_sdk.schema.data_spec.source_item_spec import SourceItemSpec

        if self.input_shape is not SourceItemSpec:
            raise ValueError('this dataset does not take source items — its spec input must be "ingest.source_item"')
        layout = dataset_layout_for(self.data_layout)   # a CSV layout refuses `append` itself
        wanted = [str(i) for i in item_ids]
        rows = {item.id: item for item in await SourceItem.get_all(
            QueryFilter(type=SourceItem.get_type(), match=ExpressionNode(op=QueryOp.IN, operands=["id", wanted]))
        )}   # one IN query, not N lookups
        batch = []
        for item_id in wanted:
            item = rows.get(item_id)
            if item is None:
                raise LookupError(f"no source_item {item_id}")
            if self.source_id and item.data_source_id != self.source_id:
                raise ValueError(f"item {item_id} belongs to another source")
            contents, provenance = item.as_row_input()
            batch.append((
                ARTIFACT_ROW(
                    kind=RowKind.TRAIN,
                    input=FolderSpec(path=INPUT, files={"item.json": FileRef(path=f"{INPUT}/item.json")}),
                    metadata={"source": provenance},
                ),
                contents,
            ))
        return layout.append_many(self._folder(), batch, dataset_id=self.id)

    async def annotate(self, row_id: str, ground_truth: Any, *, by: str = "") -> None:
        """One row's gold label -- a value, or a LIST of acceptable answers -- validated against
        the output shape (``ValidationError``). It REPLACES any gold the row had. The gold of a
        named shape is written as the shape's own document (``ground_truth/decision.json``) so it
        reads back exactly as the walker writes it; any other as ``ground_truth/label.json``."""
        from pydantic import TypeAdapter  # noqa: PLC0415

        from flow_sdk.schema.data_spec.layout import (  # noqa: PLC0415
            ANNOTATION_FILE,
            _main_document,
            dataset_layout_for,
        )

        shape = self.output_shape
        adapter = TypeAdapter(list[shape] if isinstance(ground_truth, list) else shape)
        payload = adapter.dump_python(adapter.validate_python(ground_truth), mode="json")
        # A NAMED shape has a document name of its own; an inline one (``{"sentiment": "string"}``)
        # would get a hash-named file, so it keeps the shape-agnostic ``label.json``.
        named = bool(getattr(shape, "spec_kind", ""))
        with self._lock():   # a row write like any other: one at a time, and said
            written = dataset_layout_for(self.data_layout).annotate(
                self._folder(), row_id, payload, dataset_id=self.id, by=by,
                main=_main_document(shape) if named else ANNOTATION_FILE,
            )
        self._tell("put", [self._key_of(written, row_id)])

    def set_data(self, row_id: str, data: dict) -> None:
        """Replace one row's free ``data`` (a suite tag, a note) -- its inputs and golds untouched."""
        from flow_sdk.schema.data_spec.layout import dataset_layout_for  # noqa: PLC0415

        with self._lock():
            written = dataset_layout_for(self.data_layout).set_data(self._folder(), row_id, dict(data), dataset_id=self.id)
        self._tell("put", [self._key_of(written, row_id)])

    def _key_of(self, written: Any, given: str) -> str:
        """The key of the row a layout write touched: the row folder its answer (a path) lies in."""
        rows = (self._folder() / ROWS_DIR).resolve()
        try:
            return Path(written).resolve().relative_to(rows).parts[0]
        except (TypeError, ValueError, IndexError):
            return given

    @property
    def row_type(self) -> Any:
        """The ``RowSpec`` every row of this dataset is -- typed when ``spec`` names its slots."""
        return self._dataset_type().row_type()

    def _typed_rows_or_raise(self) -> Any:
        row = self.row_type
        if row.input_type() is None:
            raise ValueError("this dataset declares no row shape (`spec`), so a row cannot be checked")
        if self.data_layout != DataLayoutEnum.IO_FOLDER:
            raise ValueError("typed rows are io_folder only")
        return row

    _ROW_KEYS = frozenset({"input", "context", "ground_truth", "output", "kind", "data"})

    @property
    def row_kind(self) -> str:
        """The kind every row is (its ``input``): a row is one instance of it, referenced as
        ``<row kind>.id.<row id>``. ``""`` when the spec names no kind."""
        from flow_sdk.datasets.links import row_kind  # noqa: PLC0415

        return row_kind(self.spec)

    def ref_of(self, row_id: str) -> str:
        """The reference other rows hold to point at this one (``value_ref``)."""
        from flow_sdk.schema.data_spec.value_ref import ref_of  # noqa: PLC0415

        return ref_of(self.row_kind, row_id) if self.row_kind else ""

    def _owner(self) -> Path:
        from flow_sdk.datasets.links import owner_of  # noqa: PLC0415

        return owner_of(self._folder())

    @staticmethod
    def version_of(row: Any) -> str:
        """A row's version (``row.version``, a digest of its files): what ``put`` / ``delete_row``
        ``expected=`` compare, so a write never lands over a change it did not see."""
        return row.version if hasattr(row, "version") else str((row or {}).get("version", ""))

    def _row_out(self, row: Any) -> dict:
        """A row as the API hands it out: its slots, plus ``key``, ``id``, ``ref`` and ``version``."""
        return {**row.model_dump(mode="json"), "ref": self.ref_of(row.id)}

    def _lock(self) -> Any:
        """One cross-process lock per project for row writes: a write's link checks (the rows it points
        at, the rows that point at it) and the write itself happen as one step, even with two writers
        (the app's server and a sync script). Held over sync code only; blocks without a timeout --
        the sections are a few file operations, so a wait that does not end is a deadlock to fix."""
        from flow_sdk.instances.atomic import locked  # noqa: PLC0415

        return locked(self._owner() / ".flow" / "dataset-rows.lock")

    def store_ids(self) -> int:
        """Store each row's id in its ``row.json`` where it still has only the legacy derived one
        (which follows the dataset's .flow id -- not in git -- and so changes on a fresh clone). Run
        once on a dataset that predates stored ids; returns how many rows it stamped."""
        from flow_sdk.schema.data_spec.layout import FolderLayout, _row_dirs, _load_row_meta, row_id, stored_row_id  # noqa: PLC0415

        self._typed_rows_or_raise()
        stamped = 0
        with self._lock():
            for ex_dir in _row_dirs(self._folder()):
                metadata, data = _load_row_meta(ex_dir)
                if not stored_row_id(metadata):
                    FolderLayout().write_row_meta(ex_dir, {**metadata, "id": row_id(ex_dir, self.id, metadata)}, data)
                    stamped += 1
        return stamped

    def _stores(self) -> tuple:
        from flow_sdk.values import store_of  # noqa: PLC0415

        return (store_of(self._folder()), store_of(self._owner()))

    def _link_details(self, row: Any, cache: Optional[dict] = None, stores: Optional[tuple] = None) -> list[dict]:
        """What a row's links break, as ``{path, code, message}``: a reference that names nothing (no
        row of its kind beside this dataset, nor a value in this dataset's or its owner's value store),
        a row kind copied in, and every rule across rows its schema declares (``flow_sdk.datasets.rules``)."""
        from flow_sdk.datasets.links import dangling_details, slot_values  # noqa: PLC0415
        from flow_sdk.datasets.rules import rule_breaks  # noqa: PLC0415

        stores, cache, out = stores or self._stores(), cache if cache is not None else {}, []
        for slot, value in slot_values(row):
            out += [{**d, "path": f"{slot}.{d['path']}"}
                    for d in dangling_details(value, self._owner(), stores=stores, cache=cache)]
            out += rule_breaks(value, self._owner(), cache=cache, path=f"{slot}.")
        return out

    def _raw_link_details(self, raw: Any, cache: Optional[dict] = None, stores: Optional[tuple] = None) -> list[dict]:
        """The reference check on a row that does not fit its shape (its slots as given / stored)."""
        from flow_sdk.datasets.links import SLOTS, raw_dangling_details  # noqa: PLC0415

        raw, stores = raw if isinstance(raw, dict) else {}, stores or self._stores()
        return [d for slot in SLOTS
                for d in raw_dangling_details(raw.get(slot), self._owner(), stores=stores, cache=cache, path=f"{slot}.")]

    def read_lenient(self) -> tuple[list, list[tuple[str, Any]]]:
        """``(rows that fit their shape, [(key, input as stored)] for those that do not)`` -- read as
        they are, no link or rule checks (``rows_and_problems`` adds those). What a scan over every row
        of a project reads (``links.link_index``)."""
        from flow_sdk.schema.data_spec.layout import FolderLayout, _row_dirs, _ReadShape  # noqa: PLC0415

        row_type = self._typed_rows_or_raise()
        layout, shape, rows, broken = FolderLayout(), _ReadShape.of(row_type), [], []
        for ex_dir in _row_dirs(self._folder()):
            try:
                row = layout.read_typed(ex_dir, row_type, dataset_id=self.id, shape=shape)
            except ValidationError:
                broken.append((ex_dir.name, _raw_input(shape, ex_dir)))
                continue
            if row is not None:
                rows.append(row)
        return rows, broken

    def _dependants(self) -> "Optional[tuple[dict, dict]]":
        """``(link index, {folder: dataset})`` over the rows that can reach a row of this dataset --
        directly or through others -- or None when none of their schemas declares a rule (then no
        row is read at all). Read ONCE; a caller writing many rows builds it once for all of them."""
        from flow_sdk.datasets.links import _manifest_spec, link_index, linkers_of, row_kind  # noqa: PLC0415
        from flow_sdk.datasets.rules import rules_of  # noqa: PLC0415
        from flow_sdk.schema.data_spec.spec import DataSpec  # noqa: PLC0415

        folders = linkers_of(self.row_kind, self._owner())
        if not any(rules_of(DataSpec.parse(kind)) for kind in (row_kind(_manifest_spec(f)) for f in folders) if kind):
            return None
        datasets: dict = {}

        def read(folder: Path) -> tuple[list, list]:
            datasets[folder] = dataset = Dataset.at(folder)
            return dataset.read_lenient() if dataset.row_kind else ([], [])

        return link_index(self._owner(), read=read, only=folders), datasets

    def _dependants_broken(self, ref: str, value: Any, dependants: "Optional[tuple[dict, dict]]" = None,
                           cache: Optional[dict] = None) -> list[dict]:
        """The rules a write of the row ``ref`` (as ``value``) would break in the rows that reach it
        -- directly or through others -- read as if it were already written. Only the datasets that
        can reach this one are read, ONCE (``_dependants``), and none when no schema among them
        declares a rule. Cycle-safe."""
        from flow_sdk.datasets.links import slot_values  # noqa: PLC0415
        from flow_sdk.datasets.rules import rule_breaks  # noqa: PLC0415

        dependants = dependants if dependants is not None else self._dependants()
        if dependants is None:
            return []
        index, datasets = dependants
        out, seen, todo, cache = [], {ref}, [ref], cache if cache is not None else {}
        while todo:
            for folder, kind, key, row in index.get(todo.pop(), []):
                if row is None:
                    continue   # a row that does not fit is reported on its own
                for slot, held in slot_values(row):
                    out += [{**d, "message": f"would break {kind} {key}: {d['message']}"}
                            for d in rule_breaks(held, self._owner(), override={ref: value}, cache=cache, path=f"{slot}.")]
                row_ref = datasets[folder].ref_of(row.id)
                if row_ref not in seen:
                    seen.add(row_ref)
                    todo.append(row_ref)
        return out

    def _unique_index(self, skip: Any = ()) -> Any:
        """Who holds which value of this dataset's ``unique`` rules (``rules.UniqueIndex``), from the
        rows as they are -- a row that no longer fits counts by its stored input -- or None when the
        row kind declares none (then no row is read). ``skip``: keys left out (rows about to go)."""
        from flow_sdk.datasets.rules import UniqueIndex, unique_rules  # noqa: PLC0415

        rules = unique_rules(self.row_type.input_type())
        if not rules:
            return None
        index, (rows, broken) = UniqueIndex(rules), self.read_lenient()
        held = [(row.key, row.input) for row in rows] + [(key, raw) for key, raw in broken if isinstance(raw, dict)]
        for key, value in sorted(held, key=lambda pair: pair[0]):
            if key not in skip:
                index.take(key, value)
        return index

    def _unique_details(self, key: str, row: Any, seen: dict) -> list[dict]:
        """The ``unique`` rules the row ``key`` (as ``row``) breaks against the other rows -- and
        against the rows already checked in this call (``seen``), which it then joins."""
        if "unique" not in seen:
            seen["unique"] = self._unique_index(seen.get("unique_skip", ()))
        if seen["unique"] is None:
            return []
        return [{**d, "path": f"input.{d['path']}"} for d in seen["unique"].take(key, row.input)]

    @staticmethod
    def _owned_details(row: Any, before: Any, by: Optional[str]) -> list[dict]:
        """The fields an outside system owns (``owned_by`` in the schema) that this write would set or
        change without being that owner (``by``). ``before`` is the row's input as it is (a value, or
        the stored dict of a row that no longer fits), None for a new row -- which may leave an owned
        field empty, never fill it."""
        owned = getattr(type(row.input), "__owned__", None) or {}
        if not owned:
            return []
        now = row.input.model_dump(mode="json")
        was = before if isinstance(before, dict) else before.model_dump(mode="json") if before is not None else {}
        out = []
        for name, owner in owned.items():
            if owner == by or now.get(name) == was.get(name):
                continue
            if before is None and now.get(name) in (None, "", [], {}):
                continue
            out.append({"path": f"input.{name}", "code": "owned", "owned_by": owner,
                        "message": f"{name} is owned by {owner}: only a writer that writes as {owner!r} (by={owner!r}) sets it"})
        return out

    def _row_in(self, raw: Any, n: int, *, keyed: bool = False, cache: Optional[dict] = None) -> Any:
        """One incoming row as the declared row type -- ``ValueError`` for a malformed row,
        ``ValidationError`` for one that does not fit the shape."""
        if not isinstance(raw, dict) or "input" not in raw:
            raise ValueError(f"row {n}: an object with an `input` is required")
        unknown = set(raw) - self._ROW_KEYS - ({"key"} if keyed else set())
        if unknown:
            raise ValueError(f"row {n}: unknown keys {sorted(unknown)}")
        row = self._typed_rows_or_raise().model_validate({k: v for k, v in raw.items() if k != "key"})
        broken = self._link_details(row, cache) if self.asset_ref else []
        if broken:
            raise LinkError(broken)
        return row

    async def append(self, rows: list[dict], *, by: Optional[str] = None) -> list[str]:
        """Typed rows in -- ``{input, context?, ground_truth?, output?, kind?, data?, key?}`` each,
        checked against the declared row shape BEFORE anything is written (one bad row writes nothing).

        The counterpart of ``promote`` for a dataset whose input is not a source item: a request, a
        prompt, anything the dataset's own spec defines. A row with a ``key`` lands in
        ``rows/<key>/`` (refused when the key is taken); the others are numbered. Returns the new
        row ids. A new row of a mirrored kind is made in the outside system first (see ``put``)."""
        return (await self._append_through(rows, by=by))[0]

    async def _append_through(self, rows: list[dict], *, by: Optional[str] = None,
                              served: bool = False) -> tuple[list[str], list[dict]]:
        """``append`` and what the outside system could not set: ``(ids, warnings)``."""
        ids, _, warnings = await self._write_through(_pairs(rows), by, None, served, lambda: self._append_here(rows, by))
        return ids, warnings

    def _append_here(self, rows: list[dict], by: Optional[str]) -> list[str]:
        from flow_sdk.schema.data_spec.layout import dataset_layout_for  # noqa: PLC0415

        with self._lock():
            typed, seen, refused = [], {"links": {}}, []
            for n, raw in enumerate(rows, 1):
                row = self._row_in(raw, n, keyed=True, cache=seen["links"])
                named = raw.get("key") or f"(row {n})"   # a numbered row has no key yet: named by its place
                refused += [{**d, "path": f"{named}.{d['path']}" if len(rows) > 1 else d["path"]}
                            for d in self._owned_details(row, None, by) + self._unique_details(named, row, seen)]
                typed.append((row, None))
            if refused:
                raise LinkError(refused)
            keys = [raw.get("key") for raw in rows]
            ids = dataset_layout_for(self.data_layout).append_many(
                self._folder(), typed, dataset_id=self.id, keys=keys)
        self._tell("put", [key or rid for key, rid in zip(keys, ids)])   # a numbered row is named by its id
        return ids

    def check(self, row: dict, *, by: Optional[str] = None) -> list[str]:
        """What is wrong with ``row`` as one row of this dataset -- ``[]`` when it fits. Writes nothing."""
        from flow_sdk.datasets.links import detail_lines  # noqa: PLC0415

        return detail_lines(self.check_details(row, by=by))

    def check_row(self, row: dict, *, by: Optional[str] = None) -> dict:
        """Would this row fit? ``{ok, errors, details}`` -- what the TypeScript ``check`` and the
        ``check-row`` action answer (``check`` is its ``errors`` alone). Writes nothing."""
        from flow_sdk.datasets.links import detail_lines  # noqa: PLC0415

        details = self.check_details(row, by=by)
        return {"ok": not details, "errors": detail_lines(details), "details": details}

    def check_details(self, row: dict, *, cache: Optional[dict] = None, by: Optional[str] = None) -> list[dict]:
        """``check`` as ``[{path, code, message}]``: ``code`` is ``shape:<pydantic type>``,
        ``dangling_ref``, ``inline_row``, ``rule``, ``unique`` (another row holds the value) or
        ``owned`` (a field an outside system owns, changed by a writer that is not it -- ``by`` says
        who is asking). A row that carries its ``key`` is checked as a ``put`` of that row would be
        (against the row it replaces); one without, as a new row. A row whose shape fails still has
        its links checked in the same answer (rules need a row that fits, so they come once it does).
        ``cache`` keeps the linked rows read across calls -- a caller checking many rows in one pass
        (a sync) passes one dict, so each linked row is read once."""
        try:
            key = row.get("key") if isinstance(row, dict) and isinstance(row.get("key"), str) and row.get("key") else None
            if key:
                # a row that names its key is judged exactly as `put(key, row)` would judge it: merged
                # with the slots it leaves out, against the row it replaces, and against the rules of
                # the rows that reach it -- nothing is written
                self._row_in(row, 1, keyed=True, cache=cache)      # its own shape first: named as given
                self._prepare_put(key, {k: v for k, v in row.items() if k != "key"}, None,
                                  {"by": by, "links": cache if cache is not None else {}})
                return []
            row = self._row_in(row, 1, keyed=True, cache=cache)
            return self._owned_details(row, None, by) + self._unique_details("(this row)", row, {})
        except ValidationError as exc:
            from flow_sdk.datasets.links import shape_details  # noqa: PLC0415

            return shape_details(exc) + (self._raw_link_details(row, cache) if self.asset_ref else [])
        except LinkError as exc:
            return list(exc.details)
        except ValueError as exc:
            return [{"path": "", "code": "row", "message": str(exc)}]

    #: The tag every row write emits (``docs/flow-events.md``): the target is the dataset, the scope its
    #: row kind (``kind:<kind>``), the data says which keys moved -- never their values. Forwarded to the app (``tags/ws_forward``).
    ROWS_CHANGED: ClassVar[str] = "dataset.rows.changed"
    #: How many keys one event names; a larger write says ``count`` and the listener re-reads.
    ROWS_CHANGED_KEYS: ClassVar[int] = 100

    def _rows_event(self, op: str, keys: list[str]) -> dict:
        keys = list(keys)
        return {"op": op, "keys": keys[: self.ROWS_CHANGED_KEYS], "count": len(keys)}

    def rows_version(self) -> str:
        """The rows as a whole, as one version (``layout.rows_version``): rides on every
        ``dataset.rows.changed`` and on ``rows()``, and ``GET rows-version`` answers it alone, so a
        listener whose socket was down learns whether anything moved without reading a row."""
        from flow_sdk.schema.data_spec.layout import rows_version  # noqa: PLC0415

        return rows_version(self.asset_ref) if self.asset_ref else ""

    def emit_rows_changed(self, op: str, keys: list[str]) -> None:
        """Say on THIS process's bus that rows changed (``op``: ``put`` / ``delete`` / ``rename`` /
        ``sync``). What the server does; a writer outside it calls ``announce``."""
        from flow_sdk.tags.bus import emit_tag  # noqa: PLC0415
        from flow_sdk.tags.envelope import target_of  # noqa: PLC0415

        if keys and self.id:
            # The scope names the row KIND, so a rule checked into a project can say which rows it is
            # about (`"scope": ["kind:<kind>"]`): the dataset's id is this machine's, the kind is not.
            kind = self.row_kind
            emit_tag(self.ROWS_CHANGED, target_of("dataset", self.id),
                     {**self._rows_event(op, keys), "version": self.rows_version()},
                     {"scope": [target_of("kind", kind)]} if kind else None)

    def announce(self, op: str, keys: list[str]) -> bool:
        """Tell the running Flowpad that rows changed, from a process that is not the server (a sync
        script, a worker): the server emits ``dataset.rows.changed`` and every open app hears it.
        Best effort by design -- an event is a hint to re-read, never the write itself: False (no
        error) when no instance is running or it does not answer."""
        if not keys or not self.id:
            return False
        try:
            from flow_sdk import local_client  # noqa: PLC0415

            local_client.graph_post(f"dataset/{self.id}/rows-changed", self._rows_event(op, keys), timeout=5)
            return True
        except Exception:  # noqa: BLE001 -- telling is never a reason for a write to fail
            return False

    def _tell(self, op: str, keys: list[str]) -> None:
        """After a row write: on the bus when this process is the server, else through it."""
        from flow_sdk.tags import ws_forward  # noqa: PLC0415

        if ws_forward.forwarding_started():
            self.emit_rows_changed(op, keys)
        else:
            self.announce(op, keys)

    _SLOT_NAMES = ("input", "context", "ground_truth", "output")

    def _prepare_put(self, key: str, row: dict, expected: Optional[str], seen: dict) -> tuple[Any, Any]:
        """One row of a put, checked and ready to write: ``(row, the row it replaces or None)``.
        Nothing is written. Called under the row lock; ``seen`` is the caller's memory for the whole
        call (the linked rows read, the read shape, the rows that reach this dataset), so a batch
        reads each of those once."""
        from flow_sdk.schema.data_spec.layout import FolderLayout, _load_row_meta, _ReadShape, check_key, row_id, row_version  # noqa: PLC0415

        row_type, layout, folder = self._typed_rows_or_raise(), FolderLayout(), self._folder()
        if not isinstance(row, dict):
            raise ValueError("row: an object is required")
        old_dir = layout.row_dir(folder, check_key(key), dataset_id=self.id)
        merged: dict[str, Any] = {}
        metadata: dict[str, Any] = {}
        old = stored = None
        if old_dir is None and expected is not None:
            raise ConflictError(f"row {key!r} is gone since version {expected}", "gone")
        if old_dir is not None:
            if expected is not None and row_version(old_dir) != expected:
                raise ConflictError(f"row {key!r} changed since version {expected}")
            metadata, merged["data"] = _load_row_meta(old_dir)
            merged["kind"] = metadata.pop("kind", None) or RowKind.TRAIN.value
            if "shape" not in seen:
                seen["shape"] = _ReadShape.of(row_type)
            try:
                old = layout.read_typed(old_dir, row_type, dataset_id=self.id, shape=seen["shape"])
            except ValidationError:
                old = None   # a row that no longer fits is being repaired: keep only its metadata
                stored = _raw_input(seen["shape"], old_dir)
            if old is not None:
                for slot in self._SLOT_NAMES:
                    value = getattr(old, slot)
                    if value is not None:
                        merged[slot] = value
        merged.update(row)
        row = self._row_in(merged, 1, cache=seen.setdefault("links", {}))
        before = old.input if old is not None else stored if isinstance(stored, dict) else None
        refused = self._owned_details(row, before, seen.get("by")) + self._unique_details(key, row, seen)
        if refused:
            raise LinkError(refused)
        if old_dir is not None and self.row_kind and self.asset_ref:
            # an edit to a row others reach must not break THEIR rules (a use case moved to
            # another persona under a deal that names the first persona's ICP)
            if "dependants" not in seen:
                seen["dependants"] = self._dependants()
            if seen["dependants"] is not None:
                broken = self._dependants_broken(self.ref_of(row_id(old_dir, self.id)), row.input,
                                                 seen["dependants"], seen.setdefault("rules", {}))
                if broken:
                    raise LinkError(broken)
        if metadata:
            row = row.model_copy(update={"metadata": {**metadata, **row.metadata}})
        return row, old

    async def put(self, key: str, row: dict, *, expected: Optional[str] = None, by: Optional[str] = None) -> str:
        """Write the row ``key`` -- create it, or replace the one there. Validated BEFORE anything is
        written, references included. Slots the row leaves out (``ground_truth``, ``output``,
        ``context``) and the row's metadata (kind, annotations, source) are kept from the row it
        replaces, so editing an input never drops its gold. ``expected`` is the ``version`` the
        caller read: a row that changed since is ``ConflictError``, nothing written. ``by`` names
        the outside system this writer writes for (``"crm"``): only it sets a field the schema marks
        ``owned_by`` that system -- anyone else changing one is refused (``LinkError``, code
        ``owned``). A ``unique`` rule another row already satisfies with the same value refuses the
        write too (code ``unique``). Returns the id.

        In a dataset a data source mirrors, a change to a field that source's system owns is SENT TO
        THAT SYSTEM FIRST, through the source's driver, and the row is then written as the system
        answered (the app's own fields as given) -- one way in, for the row actions and for this call
        alike. Refusals: ``not_writable`` (the map cannot write that field), ``source_refused`` (the
        system said no), ``unlinked``, ``misfit``. Only the server reaches a driver: in any other
        process (a script) the change is refused ``owned`` -- send it with the ``put-row`` action."""
        return (await self._put_through(key, row, expected=expected, by=by))[0]

    async def _outside_first(self, rows: list[tuple[Optional[str], dict]], by: Optional[str],
                             expected: Optional[dict], served: bool) -> Optional[tuple]:
        """``projection.write_through`` for a write made in the server (``served``: a row action; or
        this process IS the server), else None -- nothing but the server holds a source's driver."""
        from flow_sdk.tags import ws_forward  # noqa: PLC0415

        if not served and not ws_forward.forwarding_started():
            return None
        through = await write_through(self, rows, by, expected)
        if through is not None and through[2] and not served:   # a row action answers them; a call has no answer for them
            logger.warning("dataset %s: %s", self.name, "; ".join(w["message"] for w in through[2]))
        return through

    def _writing(self) -> asyncio.Lock:
        """Held while a write goes out to the system that owns the rows: the version a writer read is
        checked, sent out and written here as one step, so a second writer from that version is refused
        instead of landing over the first, out there and here in a different order. Per process: only
        the server holds a driver (``_outside_first``)."""
        return keyed_loop_lock(_WRITING, str(self._folder()))

    async def _write_through(self, pairs: list[tuple[Optional[str], dict]], by: Optional[str], expected: Optional[dict],
                             served: bool, here: Any) -> tuple[list[str], list[Optional[str]], list[dict]]:
        """THE row write: ``pairs`` are ``(key, row)`` -- a key of None for a row not named yet. What an
        outside system owns goes to it first (``_outside_first``) and the rows are then written as it
        answered, under the keys its mirror gives them; when nothing of the kind applies, ``here()``
        writes them as given. → ``(ids, the keys written, warnings)``."""
        async with self._writing():
            through = await self._outside_first(pairs, by, expected, served) if pairs else None
            if through is None:
                return here(), [key for key, _ in pairs], []
            sent, as_, warnings = through
            return self._put_many_here([{**row, "key": key} for key, row in sent], None, as_), [key for key, _ in sent], warnings

    async def _put_through(self, key: str, row: dict, *, expected: Optional[str] = None, by: Optional[str] = None,
                           served: bool = False) -> tuple[str, str, list[dict]]:
        """``put`` and what the outside system could not set: ``(id, the key written, warnings)``."""
        ids, keys, warnings = await self._write_through([(key, row)], by, {key: expected}, served,
                                                        lambda: [self._put_here(key, row, expected, by)])
        return ids[0], keys[0], warnings

    def _put_here(self, key: str, row: dict, expected: Optional[str], by: Optional[str]) -> str:
        from flow_sdk.schema.data_spec.layout import FolderLayout  # noqa: PLC0415

        with self._lock():
            row, _ = self._prepare_put(key, row, expected, {"by": by})
            rid = FolderLayout().put_row(self._folder(), key, row, dataset_id=self.id)
        self._tell("put", [key])
        return rid

    def _keyed(self, rows: Any) -> list[tuple[str, dict]]:
        """``[{key, input, ...}]`` as ``[(key, row without its key)]`` -- every row keyed, no key twice."""
        if not isinstance(rows, list):
            raise ValueError("rows: a list is required")
        out, taken = [], set()
        for n, raw in enumerate(rows, 1):
            if not isinstance(raw, dict) or not isinstance(raw.get("key"), str) or not raw["key"]:
                raise ValueError(f"row {n}: a `key` is required")
            if raw["key"] in taken:
                raise ValueError(f"row {n}: key {raw['key']!r} is given twice")
            taken.add(raw["key"])
            out.append((raw["key"], {k: v for k, v in raw.items() if k != "key"}))
        return out

    def _prepare_many(self, rows: list[tuple[str, dict]], expected: dict, seen: dict, *,
                      lenient: bool = False) -> tuple[list, list[dict]]:
        """Every row of a batch checked (``_prepare_put``): ``(ready, misfit)`` -- ``[(key, row,
        old)]`` for the rows that fit, and ``[{key, row, details}]`` for each that does not (its
        shape, links, rules; the details' paths are the row's own, ``input.x``). Unless ``lenient``,
        one row that does not fit is ONE ``LinkError`` naming every such row under ``<key>.``;
        lenient (a mirror) still refuses an ``owned`` detail -- the writer's mistake, not a value.
        ``ConflictError`` is raised at once (the caller must re-read); so is a malformed row (not an
        object, unknown keys)."""
        from flow_sdk.datasets.links import shape_details  # noqa: PLC0415

        ready, conflicts, misfit = [], [], []
        for key, row in rows:
            try:
                row, old = self._prepare_put(key, row, expected.get(key), seen)
            except ConflictError as exc:
                conflicts.append(str(exc))
            except ValidationError as exc:
                misfit.append({"key": key, "row": row, "details": shape_details(exc)
                               + (self._raw_link_details(row, seen.get("links")) if self.asset_ref else [])})
            except LinkError as exc:
                misfit.append({"key": key, "row": row, "details": list(exc.details)})
            except ValueError as exc:
                raise LinkError([{"path": key, "code": "row", "message": str(exc)}]) from exc
            else:
                ready.append((key, row, old))
        if conflicts:
            raise ConflictError("; ".join(conflicts))
        if misfit and (not lenient or any(d.get("code") == "owned" for m in misfit for d in m["details"])):
            raise LinkError([{**d, "path": f"{m['key']}.{d['path']}".rstrip(".")} for m in misfit for d in m["details"]])
        return ready, misfit

    async def put_many(self, rows: list[dict], *, expected: Optional[dict[str, str]] = None,
                       by: Optional[str] = None) -> list[str]:
        """Write several rows as ONE step -- ``[{key, input, ...}]``, each created or replaced like
        ``put`` -- all of them, or none: every row is checked first, and one that does not fit
        (``LinkError``, its details under ``<key>.<path>``) or changed since the version in
        ``expected`` (``{key: version}``; ``ConflictError``) writes nothing. Each row is checked
        against the rows as they are BEFORE the call. The lock is taken once and what the checks
        read (linked rows, the rows that reach this dataset) is read once. Returns the ids, in order.
        Changes to fields an outside system owns go to it first (see ``put``)."""
        return (await self._put_many_through(rows, expected=expected, by=by))[0]

    async def _put_many_through(self, rows: list[dict], *, expected: Optional[dict[str, str]] = None,
                                by: Optional[str] = None, served: bool = False) -> tuple[list[str], list[str], list[dict]]:
        """``put_many`` and what the outside system could not set: ``(ids, the keys written, warnings)``."""
        return await self._write_through(_pairs(rows), by, expected, served, lambda: self._put_many_here(rows, expected, by))

    def _put_many_here(self, rows: list[dict], expected: Optional[dict[str, str]], by: Optional[str]) -> list[str]:
        from flow_sdk.schema.data_spec.layout import FolderLayout  # noqa: PLC0415

        keyed, layout, folder = self._keyed(rows), FolderLayout(), self._folder()
        with self._lock():
            ready, _ = self._prepare_many(keyed, expected or {}, {"by": by})
            ids = [layout.put_row(folder, key, row, dataset_id=self.id) for key, row, _ in ready]
        self._tell("put", [key for key, _ in keyed])
        return ids

    async def sync(self, rows: list[dict], *, prune: bool = True, match: Any = None, by: Optional[str] = None,
                   lenient: bool = False) -> dict:
        """Make the dataset hold exactly ``rows`` (``[{key, input, ...}]``) -- what a mirror of an
        outside system calls each run. A key that is new is created, one whose value changed is
        replaced, one that reads the same is left untouched (its version does not move), and -- with
        ``prune`` -- a row whose key is not listed is removed. ``match`` (an expression or a
        ``{field: value}`` map over the row: ``flow_sdk.datasets.query``) narrows what is pruned to
        the rows it matches, so a writer that owns one slice of a dataset never removes another's.

        One step, all or nothing: every row is checked first (as ``put_many``), every removal too (as
        ``delete_rows``: a row still referenced refuses the whole sync). ``by`` is the outside system
        this sync writes for (see ``put``): what lets it set the fields that system owns. Returns
        ``{created, updated, unchanged, deleted}``, each a list of keys.

        ``lenient`` is for a MIRROR of an outside system, whose values are not this writer's to fix:
        a row whose value does not fit the row kind (a shape the schema does not allow, a link that
        does not hold) is kept as it came -- a PROBLEM row, read by ``rows_and_problems`` with its
        input intact, invisible to ``rows`` -- and named in the answer's ``misfit`` (``[{key,
        details}]``), while every other row is written. A misfit still listed is never pruned. A row
        that is no longer listed but that another row still references is KEPT (it would leave that
        reference dangling) and named in ``referenced`` (``[{key, details}]``, code ``referenced``),
        while the rest is written and pruned; it goes on the sweep after the reference does. A row
        refused as ``owned`` (a field this writer may not set) still refuses the whole sync: that is
        the caller's mistake, not the outside system's value."""
        from flow_sdk.datasets.query import expression, matches  # noqa: PLC0415
        from flow_sdk.schema.data_spec.layout import FolderLayout, _ReadShape  # noqa: PLC0415

        keyed, layout, folder, node = self._keyed(rows), FolderLayout(), self._folder(), expression(match)
        with self._lock():
            gone = []
            if prune:
                listed = {key for key, _ in keyed}
                kept, problems = self.rows_and_problems()
                here = [(r.key, self._row_out(r)) for r in kept] + [(p["key"], {"key": p["key"], "id": p["id"], "input": p["input"]}) for p in problems]
                gone = [key for key, shown in here if key not in listed and matches(node, shown)]
            # a mirror keeps a row that is gone outside while something here still references it
            used = self._still_used(gone) if lenient and gone else {}
            gone = [key for key in gone if key not in used]
            # the rows about to go no longer hold their unique values: a new row may take one over
            seen = {"by": by, "unique_skip": set(gone)}
            ready, misfit = self._prepare_many(keyed, {}, seen, lenient=lenient)
            out: dict[str, Any] = {"created": [], "updated": [], "unchanged": [], "deleted": []}
            write = []
            for key, row, old in ready:
                same = old is not None and all(
                    getattr(row, slot) == getattr(old, slot) for slot in self._SLOT_NAMES) and row.kind == old.kind
                out["unchanged" if same else "created" if layout.row_dir(folder, key, dataset_id=self.id) is None else "updated"].append(key)
                if not same:
                    write.append((key, row))
            if not lenient:   # a lenient sync has already set aside every row still referenced (`used`)
                self._check_delete(gone, {})
            for key, row in write:
                layout.put_row(folder, key, row, dataset_id=self.id)
            if misfit:
                main = (seen.get("shape") or _ReadShape.of(self._typed_rows_or_raise())).mains["input"]
                for m in misfit:
                    layout.put_problem_row(folder, m["key"], m["row"].get("input") or {}, dataset_id=self.id, main_document=main)
                out["misfit"] = [{"key": m["key"], "details": m["details"]} for m in misfit]
            if used:
                out["referenced"] = [{"key": key, "details": [{"path": "", "code": "referenced", "message": why}]}
                                     for key, why in used.items()]
            out["deleted"] = [layout.delete_row(folder, key, dataset_id=self.id) for key in gone]
        self._tell("sync", out["created"] + out["updated"] + out["deleted"] + [m["key"] for m in misfit])   # nothing moved: nothing said
        return out

    def delete_row(self, key_or_id: str, *, expected: Optional[str] = None) -> str:
        """Remove one row. Returns its key; ``LookupError`` when there is none, ``LinkError`` while
        another row beside this dataset still references it (delete or re-point that one first),
        ``ConflictError`` when ``expected`` (the version read) is not the row's version any more."""
        return self.delete_rows([key_or_id], expected=None if expected is None else {key_or_id: expected})[0]

    async def mirror(self, items: Any, map: dict, *, by: Optional[str] = None, prune: bool = True,   # noqa: A002 -- the word
                     match: Any = None) -> dict:
        """Make this dataset the typed MIRROR of a data source: each of the source's items becomes one
        row of this dataset's kind, and the dataset is made to hold exactly those (``sync``: created /
        updated / unchanged / deleted; rows are YOUR model -- kinds, links, ``rules``). The outside
        system's values are not ours to fix: a record whose value does not fit the row kind is kept as
        a PROBLEM row (``rows_and_problems``), named in the answer's ``misfit`` (``[{key, details}]``),
        and every other record is still mirrored (``sync(lenient=True)``).

        ``items`` is a ``DataSource`` (in the server: its records are read) or the items themselves, a
        list of dicts (a script: ``local_client.graph_get("source_item", {...})``). ``map`` says how an
        item becomes a row, in the path grammar -- ``{"key": "external_id", "input": {"name": "name",
        "stage": "data.stage", "crm_id": "external_id"}}``: each value is a PATH into the item
        (``{"value": x}`` is a constant; a nested object maps field by field; a path through ``*``
        gives a list). ``{"link": <kind>, "by": <field>, "path": <path>}`` makes the outside system's
        id at ``path`` a LINK: the row of ``kind`` whose ``by`` -- a ``unique`` field of that kind --
        holds it (one reference, or a list through ``*``); an id no row holds is left out and named
        in the answer's ``unlinked`` (``[{key, field, value}]``). The mirror owns the
        fields the map names and no others: a field the app keeps on a mirrored row stays as it is.
        An item whose ``key`` path is empty is skipped; a key is made a row key (lowercased, other
        characters ``-``).
        ``by`` names the outside system these rows are written as (the owner of the schema's
        ``owned_by`` fields); it defaults to the source's provider. ``match`` narrows what ``prune``
        may remove, as in ``sync``."""
        import re  # noqa: PLC0415

        from flow_sdk.datasets.query import Many, field_of  # noqa: PLC0415
        from flow_sdk.datasets.rules import unique_rules  # noqa: PLC0415

        if not isinstance(map, dict) or not isinstance(map.get("key"), str) or not isinstance(map.get("input"), dict):
            raise ValueError('map: {"key": <path>, "input": {<field>: <path>}} is required')
        provider = None
        if not isinstance(items, list):
            from flow_sdk.builtin.source_item import SourceItem  # noqa: PLC0415

            provider = getattr(items, "provider", None) or None
            found = await SourceItem.get_all({"data_source_id": str(items.id)}) or []
            items = [item.model_dump(mode="json") for item in found]

        targets: dict[tuple[str, str], dict[str, str]] = {}
        unlinked: list[dict] = []

        def linked_by(kind: str, by: str) -> dict[str, str]:
            """``{<by> value: reference}`` over every row of ``kind`` -- read once per mirror."""
            if (kind, by) not in targets:
                found = Dataset.for_kind(kind, self._owner())
                if not found:
                    raise ValueError(f"map: no dataset holds {kind} rows to link to")
                index: dict[str, str] = {}
                for dataset in found:
                    by_key = by == ROW_KEY   # the row's own key names one row by definition: no rule needed
                    if not by_key and [by] not in [list(rule.unique) for rule in unique_rules(dataset.row_type.input_type())]:
                        raise ValueError(f"map: {by} is not a unique field of {kind}, so it cannot name one row")
                    for row in dataset.read_lenient()[0]:
                        held = row.key if by_key else getattr(row.input, by, None)
                        if held not in (None, ""):
                            index[str(held)] = dataset.ref_of(row.id)
                targets[(kind, by)] = index
            return targets[(kind, by)]

        def shaped(spec: Any, item: dict, key: str, where: str) -> Any:
            if isinstance(spec, str):
                found = field_of(item, spec)
                return list(found) if isinstance(found, Many) else found
            if isinstance(spec, dict) and set(spec) == {"value"}:
                return spec["value"]
            if is_link(spec):
                index, found = linked_by(str(spec["link"]), str(spec["by"])), field_of(item, spec["path"])
                ids = [found] if not isinstance(found, Many) else list(found)
                refs = []
                for outside in (str(v) for v in ids if v not in (None, "")):
                    if outside in index:
                        refs.append(index[outside])
                    else:
                        unlinked.append({"key": key, "field": where, "value": outside})
                return refs if isinstance(found, Many) else (refs[0] if refs else None)
            if isinstance(spec, dict):
                made = {name: shaped(inner, item, key, f"{where}.{name}" if where else name) for name, inner in spec.items()}
                return {name: value for name, value in made.items() if value is not None}
            if isinstance(spec, list):
                return [value for value in (shaped(inner, item, key, where) for inner in spec) if value is not None]
            raise ValueError(f"map: a path, {{\"value\": x}}, {{\"link\", \"by\", \"path\"}}, an object or a list is required, not {spec!r}")

        # The mirror owns the fields its map names and no others: what the app keeps on a mirrored
        # row (its notes, its tags) stays, whatever the source did to the rest.
        kept, problems = self.rows_and_problems()
        held = {row.key: row.input.model_dump(mode="json", exclude_none=True) for row in kept}
        held.update({p["key"]: p["input"] for p in problems if isinstance(p.get("input"), dict)})
        # A field the kind REQUIRES that neither the map nor the row supplies -- the app's own list or
        # map (a deal's objections, its stage dates) -- starts EMPTY on a row the mirror makes: a
        # required list with nothing in it is `[]`, not absent, or every new record would be a misfit.
        empties = self._empty_required(self.row_type.input_type())
        # A row is found by its NATURAL key -- the field the map's key path is mapped to (``crm_id``) --
        # never by its row key alone: a row made before the mirror (keyed as its author liked) or
        # renamed since keeps its key, its id and every link to it. A record no row holds gets a key
        # made from its id.
        key_field_ = next((name for name, path in map["input"].items() if path == map["key"]), None)
        keyed_by_natural = {str(fields[key_field_]): key for key, fields in held.items()
                            if key_field_ and fields.get(key_field_) not in (None, "")} if key_field_ else {}
        rows, taken = [], set()
        for item in items:
            named = field_of(item, map["key"])
            if named in (None, ""):
                continue
            key = keyed_by_natural.get(str(named)) or re.sub(r"[^a-z0-9_-]+", "-", str(named).lower()).strip("-")
            if not key or key in taken:
                raise ValueError(f"mirror: two items map to the row key {key!r} (from {named!r})" if key else f"mirror: {named!r} gives no row key")
            taken.add(key)
            own = {name: value for name, value in held.get(key, {}).items() if name not in map["input"]}
            rows.append({"key": key, "input": {**empties, **own, **shaped(map["input"], item, key, "")}})
        done = await self.sync(rows, prune=prune, match=match, by=by or provider, lenient=True)
        return {**done, "unlinked": unlinked} if unlinked else done

    @staticmethod
    def _empty_required(input_type: Any) -> dict[str, Any]:
        """``{field: [] | {}}`` for every REQUIRED list or map field of ``input_type``: the empty value a
        writer that does not know the field (a mirror) gives it, so the row fits."""
        from typing import get_origin  # noqa: PLC0415

        from flow_sdk.schema.data_spec.io.placement import unwrap  # noqa: PLC0415

        out: dict[str, Any] = {}
        for name, field in input_type.model_fields.items():
            if not field.is_required():
                continue
            core = unwrap(field.annotation)
            origin = get_origin(core) or core
            if origin in (list, tuple, set, frozenset):
                out[name] = []
            elif origin is dict or (isinstance(origin, type) and hasattr(origin, "model_fields")
                                   and all(not f.is_required() for f in origin.model_fields.values())):
                out[name] = {}
        return out

    def _check_delete(self, keys: list[str], expected: dict[str, str]) -> list[Path]:
        """The row folders ``keys`` (keys or ids) name, once every one of them may go -- else the
        error ``delete_rows`` documents. Nothing is removed. Called under the row lock."""
        from flow_sdk.schema.data_spec.layout import FolderLayout, row_version  # noqa: PLC0415

        layout, folder = FolderLayout(), self._folder()
        found = {given: layout.row_dir(folder, given, dataset_id=self.id) for given in dict.fromkeys(keys)}
        missing = [given for given, ex_dir in found.items() if ex_dir is None]
        if missing:
            raise LookupError(f"no row {', '.join(missing)} in {folder}")
        dirs = list({ex_dir.name: ex_dir for ex_dir in found.values()}.values())
        stale = [ex_dir.name for given, ex_dir in found.items() if given in expected and row_version(ex_dir) != expected[given]]
        if stale:
            raise ConflictError(f"row {', '.join(repr(k) for k in stale)} changed since the version read")
        held = self._referenced(dirs, self._users(dirs), {ex_dir.name for ex_dir in dirs})
        if held:
            raise LinkError([{"path": key if len(dirs) > 1 else "", "code": "referenced", "message": why}
                             for key, why in held.items()])
        return dirs

    def _referenced(self, dirs: list[Path], users: list[list[dict]], going: set[str]) -> dict[str, str]:
        """``{key: "used by ..."}`` for each of ``dirs`` a row still references. Rows of this dataset
        that are ``going`` in the same step do not hold each other back."""
        folder, held = self._folder(), {}
        for ex_dir, by in zip(dirs, users):
            still = [f"{u['kind']} {u['key']}" for u in by if not (u["folder"] == folder and u["key"] in going)]
            if still:
                held[ex_dir.name] = f"used by {', '.join(still)}"
        return held

    def _still_used(self, keys: list[str]) -> dict[str, str]:
        """Of the rows ``keys`` a lenient sync would remove, the ones something still references
        (``{key: "used by ..."}``) -- and so the ones it keeps. A row kept keeps what IT references in
        turn, so this narrows the going set until it stops changing."""
        from flow_sdk.schema.data_spec.layout import FolderLayout  # noqa: PLC0415

        layout, folder = FolderLayout(), self._folder()
        dirs = [ex_dir for ex_dir in (layout.row_dir(folder, key, dataset_id=self.id) for key in keys) if ex_dir is not None]
        users, going, held = self._users(dirs), {ex_dir.name for ex_dir in dirs}, {}
        while True:
            more = self._referenced([d for d in dirs if d.name in going], [u for d, u in zip(dirs, users) if d.name in going], going)
            if not more:
                return held
            held.update(more)
            going -= set(more)

    def delete_rows(self, keys: list[str], *, expected: Optional[dict[str, str]] = None) -> list[str]:
        """Remove several rows as ONE step -- all of them, or none. Returns their keys. Everything is
        checked before anything is removed: ``LookupError`` names every key that is no row,
        ``ConflictError`` every row whose version is not the one in ``expected`` (``{key or id:
        version}``), ``LinkError`` every row another row still references. Rows removed together do
        not hold each other back (a parent and its children go in one call). The rows that could
        reference these are read once for the whole call, and not at all when no schema links to
        this dataset's kind."""
        from flow_sdk.schema.data_spec.layout import FolderLayout  # noqa: PLC0415

        self._typed_rows_or_raise()
        layout, folder = FolderLayout(), self._folder()
        with self._lock():
            gone = [layout.delete_row(folder, ex_dir.name, dataset_id=self.id)
                    for ex_dir in self._check_delete(keys, expected or {})]
        self._tell("delete", gone)
        return gone

    def rename_row(self, key_or_id: str, new_key: str, *, expected: Optional[str] = None) -> str:
        """Give one row a new key. Its id stays (stored in the row), so every reference to it still
        resolves. Returns the id. ``ConflictError`` when ``expected`` (the version read) is not the
        row's version any more."""
        from flow_sdk.schema.data_spec.layout import FolderLayout, row_version  # noqa: PLC0415

        self._typed_rows_or_raise()
        layout = FolderLayout()
        with self._lock():
            if expected is not None:
                ex_dir = layout.row_dir(self._folder(), key_or_id, dataset_id=self.id)
                if ex_dir is not None and row_version(ex_dir) != expected:
                    raise ConflictError(f"row {ex_dir.name!r} changed since version {expected}")
            rid = layout.rename_row(self._folder(), key_or_id, new_key, dataset_id=self.id)
        self._tell("rename", [key_or_id, new_key])
        return rid

    def row(self, row_id: str) -> Optional[dict]:
        """One row with its slots' VALUES (not paths) -- what an editor shows. None if absent."""
        from flow_sdk.schema.data_spec.layout import FolderLayout  # noqa: PLC0415

        row_type = self._typed_rows_or_raise()
        layout = FolderLayout()
        ex_dir = layout.row_dir(self._folder(), row_id, dataset_id=self.id)
        if ex_dir is None:
            return None
        row = layout.read_typed(ex_dir, row_type, dataset_id=self.id)
        return None if row is None else self._row_out(row)

    def validate_rows(self) -> list[dict]:
        """Every row read as the declared shape: ``[{row_id, key, error}]`` for the rows that do
        not fit. Indexing reads rows as artifacts on purpose (fast, never fatal); this is the check."""
        return self.rows_and_problems()[1]

    def rows_and_problems(self) -> tuple[list, list[dict]]:
        """``(rows that fit, problems)`` -- one row that does not fit never hides the others. A
        problem is ``{id, ref, key, version, error, errors, details, input}`` (``row_id`` = ``id``:
        DEPRECATED, the old name -- use ``id`` / ``ref``; ``details`` = ``errors`` as ``{path, code,
        message}``): ``errors`` lists everything
        wrong with the row, a dangling reference included; ``error`` is the first; ``input`` is the
        row's input as stored, unchecked (None when unreadable) -- so a caller can still find the
        row by a natural key in it and repair it."""
        from flow_sdk.datasets.links import detail_lines, shape_details  # noqa: PLC0415
        from flow_sdk.schema.data_spec.layout import FolderLayout, _row_dirs, _ReadShape, row_id, row_version  # noqa: PLC0415

        row_type = self._typed_rows_or_raise()
        layout, rows, problems, shape, cache = FolderLayout(), [], [], _ReadShape.of(row_type), {}
        stores = self._stores() if self.row_kind else ()
        for ex_dir in _row_dirs(self._folder()):
            try:
                row = layout.read_typed(ex_dir, row_type, dataset_id=self.id, shape=shape)
            except ValidationError as exc:
                details, failed = shape_details(exc), True
            else:
                if row is None:
                    continue
                details, failed = (self._link_details(row, cache, stores) if self.row_kind else []), False
                if not details:
                    rows.append(row)
                    continue
            raw = _raw_input(shape, ex_dir)
            if failed and self.row_kind:
                details += self._raw_link_details({"input": raw}, cache, stores)
            rid, errors = row_id(ex_dir, self.id), detail_lines(details)
            problems.append({"row_id": rid, "id": rid, "ref": self.ref_of(rid), "key": ex_dir.name,
                             "error": errors[0], "errors": errors, "details": details,
                             "version": row_version(ex_dir), "input": raw})
        # ``unique`` rules: of the rows that share a value, the first by key keeps it; the others are
        # problems naming it (a hand edit or a ``git pull`` can bring a duplicate no write would allow)
        from flow_sdk.datasets.rules import UniqueIndex, unique_rules  # noqa: PLC0415

        rules = unique_rules(row_type.input_type())
        if rules:
            index, kept = UniqueIndex(rules), []
            for row in sorted(rows, key=lambda r: r.key):
                details = [{**d, "path": f"input.{d['path']}"} for d in index.take(row.key, row.input)]
                if not details:
                    kept.append(row)
                    continue
                errors = detail_lines(details)
                problems.append({"row_id": row.id, "id": row.id, "ref": self.ref_of(row.id), "key": row.key,
                                 "error": errors[0], "errors": errors, "details": details,
                                 "version": row.version, "input": row.input.model_dump(mode="json")})
            rows = kept
        return rows, problems

    def _linked(self, records: Optional[dict] = None) -> Any:
        """Reads the rows links name, for one call: ``linked(ref) -> {dataset_id, key, row} | None`` --
        the ``/refs/<ref>`` answer. Each dataset a link leads into is read ONCE, on first use.
        ``records`` are RECORDS the caller already read, by reference (``{ref: record as a dict}``): a
        link to one is followed into it, its fields read as a row's ``input``."""
        from flow_sdk.datasets.links import find_row  # noqa: PLC0415
        from flow_sdk.schema.data_spec.value_ref import parse_ref  # noqa: PLC0415

        owner, cache, folders = self._owner(), {}, {}

        def linked(ref: str) -> Optional[dict]:
            if records and ref in records:
                rid = parse_ref(ref)[1]  # type: ignore[index]
                return {"record": records[ref], "row": {"key": rid, "id": rid, "ref": ref, "input": records[ref]}}
            found = find_row(ref, owner, cache=cache)
            if found is None:
                return None
            folder, key = found
            if folder not in folders:
                dataset = self if folder == self._folder() else Dataset.at(folder)
                folders[folder] = (dataset.id, {r.key: dataset._row_out(r) for r in dataset.read_lenient()[0]})
            dataset_id, rows = folders[folder]
            return {"dataset_id": dataset_id, "key": key, "row": rows[key]} if key in rows else None

        return linked

    def _answered(self, match: Any, records: Optional[dict]) -> Any:
        """``match`` with its sub-queries answered (``query.with_subqueries``): each asks this dataset,
        or the one dataset of the kind it names, for the values a path takes in the rows that match."""
        from flow_sdk.datasets.query import Many, expression, field_of, with_subqueries  # noqa: PLC0415
        from flow_sdk.schema.data_spec.declared import kind_in  # noqa: PLC0415

        def values(path: str, sub: Any, of: Optional[str]) -> list:
            source = self
            if of:
                found = Dataset.for_kind(kind_in(self._owner(), of) or of, self._owner())
                if len(found) != 1:
                    raise ValueError(f"sub-query: expected one dataset of {of!r}, found {len(found)}")
                source = found[0]
            linked = source._linked(records)
            follow = lambda ref: (linked(ref) or {}).get("row")   # noqa: E731
            seen: dict = {}
            for row in source.query(sub, records=records)["rows"]:
                held = field_of(row, path, follow)
                for value in (held if isinstance(held, Many) else [held]):
                    if value is not None:
                        seen.setdefault(repr(value), value)
            return list(seen.values())

        return with_subqueries(expression(match), values)

    def query(self, match: Any = None, *, order_by: Any = None, limit: Optional[int] = None, offset: Optional[int] = None,
              q: Optional[str] = None, expand: Optional[list[str]] = None, records: Optional[dict] = None) -> dict:
        """SOME of the rows: ``{rows, total, problems}``. ``match`` is an expression (``{op, operands}``)
        or a plain ``{path: value}`` map over a row as the API hands it out. A path is written as a
        schema's rules write theirs, with the slot spelled out (``flow_sdk.datasets.query``): ``key``,
        ``input.stage``, ``input.stage_dates.won``, ``input.tags.*`` (any element), and
        ``input.persona.icp`` -- a path FOLLOWS a link into the linked row (``input.persona.key`` is
        that row's key). ``q`` keeps the rows whose text holds every word of it. ``order_by`` is
        ``{path: "asc"|"desc"}`` (or a list of them); ``limit`` / ``offset`` page the result.

        ``rows`` are dicts (``key``, ``id``, ``ref``, ``version`` and the slots' values), ``total`` is
        how many matched before paging, and ``problems`` is EVERY row that does not fit -- a filter
        never hides a broken row. ``expand`` names link paths (``["input.persona"]``): the rows they
        lead to come back beside, once each, as ``linked: {<ref>: {dataset_id, key, row}}`` -- the
        rows themselves keep their references, so one can be put back as it was read.

        A JOIN on a value that is not a link is a sub-query in ``$IN`` / ``$NIN``: ``{"op": "$IN",
        "operands": ["input.email", {"op": "$PROP", "operands": ["input.email", {"input.metric":
        "em_reply"}]}]}`` -- the rows whose email is among the emails of the rows that match (a third
        operand names another kind's rows). ``records`` (``{ref: record}``) are records the caller
        already read: a path then continues into a linked record (``input.email.author_display``) --
        the ``rows`` action reads them itself; a script passes what ``local_client`` gave it."""
        from flow_sdk.datasets.query import Many, field_of, select  # noqa: PLC0415

        match = self._answered(match, records)
        rows, problems = self.rows_and_problems()
        linked = self._linked(records)
        follow = lambda ref: (linked(ref) or {}).get("row")   # noqa: E731
        page, total = select((self._row_out(r) for r in rows), match=match, order_by=order_by, limit=limit,
                             offset=offset, q=q, follow=follow)
        out = {"rows": page, "total": total, "problems": problems}
        if expand:
            if not isinstance(expand, list) or not all(isinstance(p, str) and p for p in expand):
                raise ValueError("expand: a list of link paths is required")
            out["linked"] = {}
            for row in page:
                for path in expand:
                    held = field_of(row, path, follow)
                    for ref in (held if isinstance(held, (Many, list)) else [held]):
                        if isinstance(ref, str) and ref not in out["linked"]:
                            found = linked(ref)
                            if found is not None and "record" in found:      # a record the caller read
                                from flow_sdk.datasets.links import record_type_of  # noqa: PLC0415
                                from flow_sdk.schema.data_spec.value_ref import parse_ref  # noqa: PLC0415

                                kind, rid = parse_ref(ref)  # type: ignore[misc]
                                out["linked"][ref] = {"type": record_type_of(kind), "id": rid, "record": found["record"]}
                            elif found is not None:
                                out["linked"][ref] = found
        return out

    def count(self, match: Any = None, *, group_by: Optional[list[str]] = None, metrics: Optional[dict[str, str]] = None,
              order_by: Any = None, week_start: str = "monday", q: Optional[str] = None, records: Optional[dict] = None) -> dict:
        """How many rows match -- the SAME ``match`` and ``q`` as ``query``, so a number and the list
        behind it are one question: ``{total, groups}``. ``group_by`` gives the count per distinct
        combination, ``[{by: {<entry>: value}, count}]``; an entry is a path (links followed, as in
        ``query``) or a date BUCKET ``<day|week|month|quarter>:<path>`` keyed ``2026-09-13`` (the
        week's first day; ``week_start`` ``"monday"`` or ``"sunday"``), ``2026-09``, ``2026-Q3``.
        ``metrics`` names further measures ``{name: "<distinct|min|max|sum>:<path>"}``, answered
        overall and per group. ``order_by`` orders the groups (by an entry, ``count`` or a metric's
        name); otherwise largest first. Rows that do not fit their shape are not counted
        (``rows_and_problems`` names them)."""
        from flow_sdk.datasets.query import count  # noqa: PLC0415

        linked = self._linked(records)
        match = self._answered(match, records)
        return count((self._row_out(r) for r in self.rows_and_problems()[0]), match=match, group_by=group_by,
                     metrics=metrics, order_by=order_by, week_start=week_start, q=q,
                     follow=lambda ref: (linked(ref) or {}).get("row"))

    def used_by(self, keys: Optional[list[str]] = None) -> dict[str, list[dict]]:
        """Who links to each row: ``{key: [{dataset_id, kind, key}]}`` for ``keys`` (keys or ids; every
        row when left out) -- ``[]`` for a row nothing links to. What a delete is refused for ("used
        by ..."), asked ahead of time; and its opposite, the rows nothing uses. Reads only the datasets
        whose schema can reach this kind (``links.linkers_of``), once."""
        from flow_sdk.schema.data_spec.layout import FolderLayout, _row_dirs  # noqa: PLC0415

        self._typed_rows_or_raise()
        layout, folder = FolderLayout(), self._folder()
        if keys is None:
            dirs = list(_row_dirs(folder))
        else:
            found = {given: layout.row_dir(folder, given, dataset_id=self.id) for given in dict.fromkeys(keys)}
            missing = [given for given, ex_dir in found.items() if ex_dir is None]
            if missing:
                raise LookupError(f"no row {', '.join(missing)} in {folder}")
            dirs = list({ex_dir.name: ex_dir for ex_dir in found.values()}.values())
        return {ex_dir.name: [{k: v for k, v in u.items() if k != "folder"} for u in users]
                for ex_dir, users in zip(dirs, self._users(dirs))}

    def _users(self, dirs: list[Path]) -> list[list[dict]]:
        """For each row folder, the rows that hold a reference to it (``used_by``'s entries, plus the
        referring dataset's ``folder`` for a caller that sets some aside)."""
        from flow_sdk.datasets.links import link_index, linkers_of  # noqa: PLC0415
        from flow_sdk.schema.data_spec.layout import row_id  # noqa: PLC0415

        if not self.row_kind or not dirs:
            return [[] for _ in dirs]
        datasets: dict = {}

        def read(at: Path) -> tuple[list, list]:
            datasets[at] = Dataset.at(at)
            return datasets[at].read_lenient()

        index = link_index(self._owner(), read=read, only=linkers_of(self.row_kind, self._owner()))
        return [[{"dataset_id": datasets[at].id, "kind": kind, "key": key, "folder": at}
                 for at, kind, key, _ in index.get(self.ref_of(row_id(ex_dir, self.id)), [])] for ex_dir in dirs]

    def read_rows(self) -> list:
        """Every row read as the declared shape (raises on a row that does not fit -- ``validate_rows``
        names them one by one)."""
        from flow_sdk.schema.data_spec.layout import FolderLayout  # noqa: PLC0415

        return FolderLayout().read(self._folder(), self._typed_rows_or_raise(), dataset_id=self.id)

    def score(self) -> dict:
        """Each recorded ``output`` against its gold answers (``flow_sdk.datasets.score``)."""
        from flow_sdk.datasets.score import score  # noqa: PLC0415

        return score(self.read_rows())

    @classmethod
    def at(cls, folder: "Path | str") -> "Dataset":
        """The dataset whose folder this is, read from disk alone -- no index, no DB row (the generic
        ``Entity.from_fs_ref``). For a shipped dataset, a script, or a test."""
        from flow_sdk.fs_store.fs_ref import FSRef  # noqa: PLC0415

        found = cls.from_fs_ref(FSRef(Path(folder), read_only=True), "dataset")
        if found is None:
            raise LookupError(f"{folder} is not a dataset folder")
        return found

    @classmethod
    def for_kind(cls, kind: str, owner: "Path | str") -> list["Dataset"]:
        """The datasets under ``<owner>/agentic-assets/dataset/`` whose rows are ``kind`` -- its full
        name, or the bare one a schema of the project defines (``gtm.icp``) -- read from disk alone,
        like ``at``. The REST twin is ``GET /kinds/<kind>/datasets``."""
        from flow_sdk.datasets.links import datasets_for_kind  # noqa: PLC0415
        from flow_sdk.schema.data_spec.declared import kind_in  # noqa: PLC0415

        return [cls.at(folder) for folder in datasets_for_kind(kind_in(Path(owner), kind) or kind, owner)]

    @classmethod
    def find_row(cls, ref: str, owner: "Path | str") -> "Optional[tuple[Dataset, str]]":
        """``(dataset, key)`` of the row a reference (``<kind>.id.<uuid>``) names, among the datasets
        under ``owner`` -- None when none holds it. The REST twin is ``GET /refs/<ref>?project=``."""
        from flow_sdk.datasets.links import find_row  # noqa: PLC0415

        found = find_row(ref, owner)
        return (cls.at(found[0]), found[1]) if found else None

    @staticmethod
    def _query_params() -> dict:
        """The read parameters of the request: ``filter`` (JSON or a map: ``match``, ``order_by``,
        ``limit``, ``offset``, ``expand`` -- or the match itself), the same names top-level (the
        filter's win), and beside them ``q``, ``group_by`` / ``expand`` (a list, or names separated by
        commas), ``metrics`` (JSON ``{name: "<op>:<path>"}``) and ``week_start``."""
        import json  # noqa: PLC0415

        params = get_current_request_info().request_parameters or {}

        def listed(value: Any) -> Optional[list]:
            if isinstance(value, str):
                value = json.loads(value) if value.lstrip().startswith("[") else [v.strip() for v in value.split(",") if v.strip()]
            return value or None

        def obj(value: Any, name: str) -> Any:
            value = json.loads(value) if isinstance(value, str) and value.strip() else value
            if value not in (None, "") and not isinstance(value, (dict, list)):
                raise ValueError(f"{name}: an object is required")
            return value or None

        raw = obj(params.get("filter"), "filter") or {}
        if not isinstance(raw, dict):
            raise ValueError("filter: an object is required")
        if not ({"match", "order_by", "limit", "offset", "expand"} & set(raw)):
            raw = {"match": raw} if raw else {}
        out = {"match": raw.get("match"), "order_by": obj(raw.get("order_by") or params.get("order_by"), "order_by"),
               "expand": listed(raw.get("expand") or params.get("expand")), "q": params.get("q") or None,
               "group_by": listed(params.get("group_by")), "metrics": obj(params.get("metrics"), "metrics"),
               "week_start": params.get("week_start") or "monday"}
        for name in ("limit", "offset"):
            value = raw.get(name, params.get(name))
            out[name] = None if value in (None, "") else int(value)
            if out[name] is not None and out[name] < 0:
                raise ValueError(f"{name}: a number from 0 is required")
        return out

    @action.get(action_name="rows")
    async def rows_action(self):
        """``{rows, total, problems}`` -- every row that fits with its slots' VALUES (and ``key``,
        ``id``, ``ref``, ``version``), and the ones that do not, by key: one bad row hides nothing.
        ``?filter=`` (``{match, order_by, limit, offset}`` as JSON) answers only the rows that match,
        ordered and paged (``Dataset.query``); ``total`` counts the matches before paging."""
        try:
            asked = self._query_params()
            found = self.query(asked["match"], order_by=asked["order_by"], limit=asked["limit"], offset=asked["offset"],
                               q=asked["q"], expand=asked["expand"], records=await self._records_asked(asked))
        except ValueError as exc:   # the dataset declares no typed rows, or the filter does not read
            return ApiFailResponse(message=str(exc), status_code=400)
        found["version"] = self.rows_version()
        return ApiSuccessResponse(data=found)

    @action.get(action_name="rows-version")
    async def rows_version_action(self):
        """``{"version"}`` -- ``rows_version``, off the loop: every reconnecting listener asks."""
        return ApiSuccessResponse(data={"version": await asyncio.to_thread(self.rows_version)})

    async def _records_asked(self, asked: dict) -> dict:
        """The RECORDS the question's paths lead to (a row's ``ingest.source_item`` link, followed or
        expanded), read from the instance's store: ``{ref: record}`` for ``query`` / ``count``. Asked
        only when a path could reach one; a script reads them through ``flow_sdk.local_client``."""
        from flow_sdk.datasets.links import record_type_of  # noqa: PLC0415
        from flow_sdk.datasets.query import asked_paths, field_of  # noqa: PLC0415
        from flow_sdk.schema.data_spec.value_ref import parse_ref  # noqa: PLC0415

        paths = asked_paths(asked["match"], asked["order_by"] if not asked.get("group_by") else None,
                            asked.get("group_by"), asked.get("metrics"), asked.get("expand"))
        if not paths:
            return {}
        cache: dict = {}
        wanted: dict[str, str] = {}
        linked = self._linked()

        def follow(ref: str) -> Optional[dict]:
            record_type = record_type_of(parse_ref(ref)[0], cache)  # type: ignore[index]
            if record_type:
                wanted[ref] = f"{record_type}-{parse_ref(ref)[1]}"  # type: ignore[index]
                return None
            return (linked(ref) or {}).get("row")

        for row in self.rows_and_problems()[0]:
            shown = self._row_out(row)
            for path in paths:
                held = field_of(shown, path, follow)          # walking is what finds the links
                for ref in (held if isinstance(held, list) else [held]):
                    if isinstance(ref, str) and parse_ref(ref) is not None:
                        follow(ref)                               # ... a link the path ENDS on, too (expand)
        records = {}
        for ref, typeid in wanted.items():
            record = await Entity.get_by_typeid(typeid)
            if record is not None:
                records[ref] = record.model_dump(mode="json")
        return records

    @action.get(action_name="count")
    async def count_action(self):
        """``{total, groups}`` -- how many rows match ``?filter=`` (as ``rows``), and per distinct
        value of ``?group_by=`` (field paths, comma-separated): ``[{by, count}]``."""
        try:
            asked = self._query_params()
            return ApiSuccessResponse(data=self.count(asked["match"], group_by=asked["group_by"], metrics=asked["metrics"],
                                                      order_by=asked["order_by"], week_start=asked["week_start"], q=asked["q"],
                                                      records=await self._records_asked(asked)))
        except ValueError as exc:
            return ApiFailResponse(message=str(exc), status_code=400)

    @action.get(action_name="used-by")
    async def used_by_action(self):
        """``GET used-by[?keys=a,b]`` → ``{used_by: {key: [{dataset_id, kind, key}]}}``: who links to each
        row (every row when ``keys`` is left out); ``[]`` for a row nothing links to. 404 a key that is no row."""
        params = get_current_request_info().request_parameters or {}
        keys = params.get("keys")
        if isinstance(keys, str):
            keys = [k.strip() for k in keys.split(",") if k.strip()]
        try:
            users = self.used_by(keys or None)
        except LookupError as exc:
            return ApiFailResponse(message=str(exc), status_code=404)
        except ValueError as exc:
            return ApiFailResponse(message=str(exc), status_code=400)
        return ApiSuccessResponse(data={"used_by": users})

    @action.post(action_name="score")
    async def score_action(self):
        """Recorded outputs scored against the gold → ``{rows, scored, correct, accuracy, wrong}``."""
        try:
            return ApiSuccessResponse(data=self.score())
        except (ValueError, ValidationError) as exc:
            return ApiFailResponse(message=str(exc), status_code=400)

    @action.post(action_name="append")
    async def append_action(self):
        """``{"rows": [...]}`` → ``{"ids", "num_rows"}``; a row that does not fit is a 400
        naming it, and nothing is written."""
        body = await read_json_body(get_current_request_info())
        if isinstance(body, ApiFailResponse):
            return body
        rows = body.get("rows")
        if not isinstance(rows, list) or not rows:
            return ApiFailResponse(message="rows: a non-empty list is required", status_code=400)
        try:
            ids, warnings = await self._append_through(rows, by=body.get("by"), served=True)
        except ValidationError as exc:
            return _misfit(exc, None, self, "a row does not match the dataset's shape")
        except LinkError as exc:
            return _refused(exc, 400)
        except ValueError as exc:
            return ApiFailResponse(message=str(exc), status_code=400)
        fresh = await self.refresh_counts()
        return _written({"ids": ids, "num_rows": fresh.num_rows}, warnings)

    async def _row_body(self, *required: str) -> "dict | ApiFailResponse":
        body = await read_json_body(get_current_request_info())
        if isinstance(body, ApiFailResponse):
            return body
        missing = [k for k in required if not body.get(k)]
        if missing:
            return ApiFailResponse(message=f"required: {', '.join(missing)}", status_code=400)
        return body

    @action.post(action_name="put-row")
    async def put_row_action(self):
        """``{"key", "row"}`` → ``{"row_id", "key", "num_rows"}``: create or replace the row
        ``key``. A row that does not fit is a 400 and nothing is written."""
        body = await self._row_body("key", "row")
        if isinstance(body, ApiFailResponse):
            return body
        try:
            eid, key, warnings = await self._put_through(body["key"], body["row"], expected=body.get("expected"),
                                                         by=body.get("by"), served=True)
        except ValidationError as exc:
            return _misfit(exc, body["row"], self, "the row does not match the dataset's shape")
        except ConflictError as exc:
            return _refused(exc, 409)
        except LinkError as exc:
            return _refused(exc, 400)
        except ValueError as exc:
            return ApiFailResponse(message=str(exc), status_code=400)
        fresh = await self.refresh_counts()
        return _written({"id": eid, "row_id": eid, "key": key, "num_rows": fresh.num_rows}, warnings)

    @action.post(action_name="delete-row")
    async def delete_row_action(self):
        """``{"key"}`` (a key or a row id) → ``{"key", "num_rows"}``; 404 when absent."""
        body = await self._row_body("key")
        if isinstance(body, ApiFailResponse):
            return body
        try:
            async with self._writing():
                gone = await delete_through(self, [body["key"]], {body["key"]: body["expected"]} if body.get("expected") else None)
                key = gone[0] if gone is not None else self.delete_row(body["key"], expected=body.get("expected"))
        except LookupError as exc:
            return ApiFailResponse(message=str(exc), status_code=404)
        except ConflictError as exc:
            return _refused(exc, 409)
        except LinkError as exc:
            return _refused(exc, 409)
        except ValueError as exc:
            return ApiFailResponse(message=str(exc), status_code=400)
        fresh = await self.refresh_counts()
        return ApiSuccessResponse(data={"key": key, "num_rows": fresh.num_rows})

    async def _bulk(self, write: Any) -> Any:
        """Run one bulk row write and answer its refusals the way the single-row actions do."""
        try:
            return await write()
        except LookupError as exc:
            return ApiFailResponse(message=str(exc), status_code=404)
        except ConflictError as exc:
            return _refused(exc, 409)
        except LinkError as exc:   # a row still referenced is a conflict; a row that does not fit is a bad request
            return _refused(exc, 409 if any(d.get("code") == "referenced" for d in exc.details) else 400)
        except ValueError as exc:
            return ApiFailResponse(message=str(exc), status_code=400)

    @action.post(action_name="put-rows")
    async def put_rows_action(self):
        """``{"rows": [{key, input, ...}], "expected"?: {key: version}}`` → ``{"ids", "keys",
        "num_rows"}``: every row created or replaced, or -- one that does not fit (400, its
        ``details`` under ``<key>.<path>``) or changed since (409) -- none of them."""
        body = await self._row_body("rows")
        if isinstance(body, ApiFailResponse):
            return body
        done = await self._bulk(lambda: self._put_many_through(body["rows"], expected=body.get("expected"),
                                                               by=body.get("by"), served=True))
        if isinstance(done, ApiFailResponse):
            return done
        ids, keys, warnings = done
        fresh = await self.refresh_counts()
        return _written({"ids": ids, "keys": keys, "num_rows": fresh.num_rows}, warnings)

    @action.post(action_name="delete-rows")
    async def delete_rows_action(self):
        """``{"keys": [...], "expected"?: {key: version}}`` → ``{"keys", "num_rows"}``: all of
        them removed, or none (404 a key that is no row, 409 a row changed since or still referenced)."""
        body = await self._row_body("keys")
        if isinstance(body, ApiFailResponse):
            return body
        if not isinstance(body["keys"], list) or not all(isinstance(k, str) for k in body["keys"]):
            return ApiFailResponse(message="keys: a list of row keys is required", status_code=400)

        async def remove() -> list[str]:
            async with self._writing():
                gone = await delete_through(self, body["keys"], body.get("expected"))
                return gone if gone is not None else self.delete_rows(body["keys"], expected=body.get("expected"))
        keys = await self._bulk(remove)
        if isinstance(keys, ApiFailResponse):
            return keys
        fresh = await self.refresh_counts()
        return ApiSuccessResponse(data={"keys": keys, "num_rows": fresh.num_rows})

    @action.post(action_name="sync-rows")
    async def sync_rows_action(self):
        """``{"rows": [...], "prune"?: true, "match"?: {...}}`` → ``{created, updated, unchanged,
        deleted, num_rows}`` (``Dataset.sync``): the dataset made to hold exactly these rows."""
        body = await read_json_body(get_current_request_info())
        if isinstance(body, ApiFailResponse):
            return body
        if not isinstance(body.get("rows"), list):
            return ApiFailResponse(message="rows: a list is required", status_code=400)
        done = await self._bulk(lambda: self.sync(body["rows"], prune=body.get("prune", True), match=body.get("match"), by=body.get("by")))
        if isinstance(done, ApiFailResponse):
            return done
        fresh = await self.refresh_counts()
        return ApiSuccessResponse(data={**done, "num_rows": fresh.num_rows})

    @action.post(action_name="mirror")
    async def mirror_action(self):
        """``{"source_id", "map", "by"?, "prune"?, "match"?}`` → ``{created, updated, unchanged, deleted,
        num_rows}``: this dataset made the typed mirror of that data source's items (``Dataset.mirror``)."""
        from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415

        body = await self._row_body("source_id", "map")
        if isinstance(body, ApiFailResponse):
            return body
        source = await DataSource.get_by_id(str(body["source_id"]))
        if source is None:
            return ApiFailResponse(message=f"no data source {body['source_id']!r}", status_code=404)
        done = await self._bulk(lambda: self.mirror(source, body["map"], by=body.get("by"), prune=body.get("prune", True), match=body.get("match")))
        if isinstance(done, ApiFailResponse):
            return done
        fresh = await self.refresh_counts()
        return ApiSuccessResponse(data={**done, "num_rows": fresh.num_rows})

    @action.post(action_name="rows-changed")
    async def rows_changed_action(self):
        """``{"op", "keys"}`` → ``{"told"}``: a writer outside the server (``Dataset.announce``) says
        rows changed, and the server emits ``dataset.rows.changed`` for it. Writes nothing."""
        body = await self._row_body("op", "keys")
        if isinstance(body, ApiFailResponse):
            return body
        if body["op"] not in ("put", "delete", "rename", "sync") or not isinstance(body["keys"], list) \
                or not all(isinstance(k, str) for k in body["keys"]):
            return ApiFailResponse(message="op: put|delete|rename|sync and keys: a list of row keys are required", status_code=400)
        self.emit_rows_changed(body["op"], body["keys"])
        return ApiSuccessResponse(data={"told": len(body["keys"])})

    @action.post(action_name="rename-row")
    async def rename_row_action(self):
        """``{"key", "new_key", "expected"?}`` → ``{"row_id", "key"}`` -- the row's id (kept)
        and its new key; 409 when ``expected`` is not the row's version any more."""
        body = await self._row_body("key", "new_key")
        if isinstance(body, ApiFailResponse):
            return body
        try:
            eid = self.rename_row(body["key"], body["new_key"], expected=body.get("expected"))
        except ConflictError as exc:
            return _refused(exc, 409)
        except LookupError as exc:
            return ApiFailResponse(message=str(exc), status_code=404)
        except ValueError as exc:
            return ApiFailResponse(message=str(exc), status_code=400)
        return ApiSuccessResponse(data={"row_id": eid, "key": body["new_key"]})

    @action.post(action_name="store-ids")
    async def store_ids_action(self):
        """``{"stamped"}``: store each row's id where it still has only the legacy derived one."""
        try:
            return ApiSuccessResponse(data={"stamped": self.store_ids()})
        except ValueError as exc:
            return ApiFailResponse(message=str(exc), status_code=400)

    @action.post(action_name="check-row")
    async def check_row_action(self):
        """``{"row"}`` → ``{"ok", "errors", "details"}``: would this row fit? Nothing is written."""
        body = await self._row_body("row")
        if isinstance(body, ApiFailResponse):
            return body
        try:
            return ApiSuccessResponse(data=self.check_row(body["row"], by=body.get("by")))
        except ValueError as exc:   # the dataset itself cannot take typed rows
            return ApiFailResponse(message=str(exc), status_code=400)

    @action.get(action_name="row")
    async def row_action(self):
        """``GET row/<row_id>`` → the row with its slots' values."""
        request_info = get_current_request_info()
        row_id = ((request_info.sub_path or "") if request_info else "").strip("/")
        if not row_id:
            return ApiFailResponse(message="row id required: row/<row_id>", status_code=400)
        try:
            found = self.row(row_id)
        except ValueError as exc:
            return ApiFailResponse(message=str(exc), status_code=400)
        except ValidationError as exc:
            return _misfit(exc, None, self, "the row does not match the dataset's shape")   # 400, as every misfit
        if found is None:
            return ApiFailResponse(message=f"no row {row_id}", status_code=404)
        return ApiSuccessResponse(data=found)

    @action.get(action_name="evals")
    async def evals_action(self):
        """``{runs, count_metrics, explain}``: every eval run on this dataset, newest first (``EvalRun``
        without slices), which metrics are counts rather than ratios, and each eval's metrics in plain
        words (``{eval: {metric: text}}``)."""
        from flow_sdk.evals import store  # noqa: PLC0415

        # File reads, off the event loop -- and independent, so side by side.
        runs, explain = await asyncio.gather(
            asyncio.to_thread(store.runs, self._folder()),
            asyncio.to_thread(store.explanations, self._folder(), self.declared_kind),
        )
        return ApiSuccessResponse(data={
            "runs": [r.model_dump(mode="json", exclude={"slices"}) for r in runs],
            "count_metrics": sorted({k for r in runs for k in r.count_metrics()}),
            "explain": explain,
        })

    @action.get(action_name="eval")
    async def eval_action(self):
        """``GET eval/<run_id>`` → ``{run, rows, count_metrics, explain}``: the ``EvalRun`` and every
        ``RowEval``, each joined to its row's ``input`` / ``context`` / ``data`` / ``kind`` -- so
        a browser drills down to what was typed, where, and what was offered, without a second request.
        A trace (how an answer was reached, ~7 KB each) is left out of the listing: only the row a
        person opens needs one -- ``GET eval/<run_id>/<row_id>`` → ``{trace}``."""
        from flow_sdk.evals import store  # noqa: PLC0415

        request_info = get_current_request_info()
        run_id, _, row_id = ((request_info.sub_path or "") if request_info else "").strip("/").partition("/")
        if not run_id:
            return ApiFailResponse(message="run id required: eval/<run_id>", status_code=400)
        try:
            run, rows = await asyncio.to_thread(store.load, self._folder(), run_id)
        except LookupError as exc:
            return ApiFailResponse(message=str(exc), status_code=404)
        if row_id:
            found = next((ex for ex in rows if ex.row_id == row_id), None)
            if found is None:
                return ApiFailResponse(message=f"no row {row_id} in run {run_id}", status_code=404)
            return ApiSuccessResponse(data={"trace": found.trace.model_dump(mode="json") if found.trace else None})

        def read_rows() -> dict:
            try:
                return {r.id: r for r in self.read_rows()}
            except (ValueError, ValidationError):
                return {}

        by_id, explain = await asyncio.gather(
            asyncio.to_thread(read_rows), asyncio.to_thread(store.explanations, self._folder(), self.declared_kind)
        )
        joined = []
        for ex in rows:
            row = by_id.get(ex.row_id)
            dumped = row.model_dump(mode="json", include={"input", "context", "data", "kind"}) if row else {}
            # A logged row keeps its own run's trace in its data -- not this eval's; it stays home too.
            if isinstance(dumped.get("data"), dict):
                dumped["data"].pop("run", None)
            joined.append({**ex.model_dump(mode="json", exclude={"trace"}), **{f"row_{k}": v for k, v in dumped.items()}})
        return ApiSuccessResponse(
            data={
                "run": run.model_dump(mode="json"),
                "rows": joined,
                "count_metrics": run.count_metrics(),
                "explain": explain.get(run.eval_name, {}),
            }
        )

    @action.post(action_name="run-eval")
    async def run_eval_action(self):
        """``{"eval"?, "kinds"?}`` → the new ``EvalRun`` (this dataset's eval, run now)."""
        from flow_sdk.evals import EvalError, run  # noqa: PLC0415

        body = await read_json_body(get_current_request_info())
        if isinstance(body, ApiFailResponse):
            return body
        kinds = body.get("kinds")
        try:
            record, _ = await run(
                self, eval_name=body.get("eval") or None, kinds=kinds if isinstance(kinds, list) else None
            )
        except EvalError as exc:
            return ApiFailResponse(message=str(exc), status_code=400)
        return ApiSuccessResponse(data=record.model_dump(mode="json", exclude={"slices"}))

    @action.post(action_name="validate")
    async def validate_action(self):
        """Every row checked against the declared shape → ``{"checked", "problems": [...]}``."""
        try:
            problems = self.validate_rows()
        except ValueError as exc:
            return ApiFailResponse(message=str(exc), status_code=400)
        fresh = await self.refresh_counts()
        return ApiSuccessResponse(data={"checked": fresh.num_rows, "problems": problems})

    @action.post(action_name="promote")
    async def promote_action(self):
        """``{"source_item_ids": [...]}`` → ``{"ids": [...], "num_rows"}``."""
        body = await read_json_body(get_current_request_info())
        if isinstance(body, ApiFailResponse):
            return body
        ids = body.get("source_item_ids")
        if not isinstance(ids, list) or not ids:
            return ApiFailResponse(message="source_item_ids: a non-empty list is required", status_code=400)
        try:
            row_ids = await self.promote(ids)
        except LookupError as exc:
            return ApiFailResponse(message=str(exc), status_code=404)
        except (ValueError, NotImplementedError) as exc:
            return ApiFailResponse(message=str(exc), status_code=400)
        fresh = await self.refresh_counts()
        return ApiSuccessResponse(data={"ids": row_ids, "num_rows": fresh.num_rows})

    @action.post(action_name="annotate")
    async def annotate_action(self):
        """``{"row_id", "ground_truth"}`` → ``{"row_id", "num_annotated"}``;
        a shape mismatch is a 400 carrying the output JSON schema."""
        from pydantic import TypeAdapter  # noqa: PLC0415

        body = await read_json_body(get_current_request_info())
        if isinstance(body, ApiFailResponse):
            return body
        row_id = str(body.get("row_id") or "")
        if not row_id or "ground_truth" not in body:
            return ApiFailResponse(message="row_id and ground_truth are required", status_code=400)
        try:
            await self.annotate(row_id, body["ground_truth"], by=current_user_id())
        except ValidationError as exc:
            return ApiFailResponse(
                message="ground_truth does not match the dataset's output shape", status_code=400,
                data={"errors": exc.errors(include_url=False), "schema": TypeAdapter(self.output_shape).json_schema()},
            )
        except LookupError as exc:
            return ApiFailResponse(message=str(exc), status_code=404)
        except NotImplementedError as exc:
            return ApiFailResponse(message=str(exc), status_code=400)
        fresh = await self.refresh_counts()
        return ApiSuccessResponse(data={"row_id": row_id, "num_annotated": fresh.num_annotated})
