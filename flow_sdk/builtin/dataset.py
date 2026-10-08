"""``Dataset`` — a folder-backed collection of examples for eval & training.

A dataset holds many ``Example`` rows in one of two physical layouts (see
``DataLayoutEnum``):

- ``CSV``        — a single ``data.csv`` file; each row is an example.
- ``IO_FOLDER``  — an ``examples/`` folder where each example dir carries
  ``input`` / ``output`` / ``ground_truth`` slots (file, folder, or numbered
  occurrences) plus ``«slot».json`` metadata sidecars and an ``example.json``.
  Legacy ``input.txt`` / ``expected.txt`` are still accepted.

Either layout parses into the same shape: one ``ExampleSpec`` row per example
whose slots are artifacts — a ``FileRef`` (an example-relative path), a
``FolderSpec`` (its members, recursively), or a ``TextSpec`` (a CSV cell) — and
whose sidecars ride in ``metadata`` under their full filename. Nothing here holds
file CONTENTS; the layout resolves a ref to bytes when a consumer asks. The
dataset ``spec`` (a :class:`DatasetSpec` parametrization) types the slots.

Every dataset JSON file (``dataset.json``, ``example.json``, ``«slot».json``) is a
two-section document — ``{"metadata": {...}, "data": {...}}``. ``metadata`` holds
flowpad-managed known fields (parsed into typed attributes); ``data`` is a free
object the use case owns. Both are surfaced on the carrier models below.

The container is the entity; an ``Example`` is a plain Pydantic row parsed from
disk on demand (a 50k-row CSV stays one record, not 50k entities). The
train/eval/test split lives *per-example* as ``Example.kind`` — "the eval set"
is simply ``dataset.examples(ExampleKind.EVAL)``.

The on-disk grammar (both layouts, per-example reads and writes, the index)
lives in ``flow_sdk/schema/data_spec/layout.py``; the indexer's extractor and
id mint in ``flow_sdk/fs_store/indexer/functions/dataset.py``; the type
registration in ``flow_sdk/schema/type_info/dataset_type_info.py``.
"""
from __future__ import annotations

import asyncio
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from pydantic import ValidationError, model_validator

from flow_sdk.api.api_types.api_field import APIField, NoDBAPIField, Persist, Sharing
from flow_sdk.core import Entity, action
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
    ExampleKind,
    ExampleSpec,
)

# Canonical per-example metadata filename inside an IO_FOLDER example dir.
# Owned here (the model module) so writers (GraphWorkflowManager's born-compatible
# example stamps) and the indexer's reader agree by construction.
from flow_sdk.schema.data_spec.layout import EXAMPLE_META  # noqa: F401 — re-exported

#: What `examples` holds: paths, folders and cells — never file CONTENTS.
ARTIFACT_ROW = DEFAULT_DATASET_SPEC.example_type()
# The manifest — also the repo walker's marker for "this folder is a dataset".
MANIFEST = "dataset.json"


# Re-exported: the enums live with the value models.
__all__ = ["Dataset", "DatasetManifestSpec", "DataLayoutEnum", "ExampleKind", "ExampleSpec", "EXAMPLE_META", "MANIFEST"]


#: A field that holds a DATASET shape — ``DatasetSpec.parse`` reads the keyword
#: form; the shared ``to_authoring_form`` emits it back (the parametrization
#: remembers its form). STRICT: a malformed spec on an API write is a 4xx, not
#: a silent None. Leniency is a DISK-READ policy and lives in ``from_fs``.





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
    examples: List[ARTIFACT_ROW] = NoDBAPIField(default_factory=list, sharing=Sharing.PRIVATE, persist=Persist.TRUE)  # type: ignore[valid-type]

    # Denormalized counts surfaced in lists — computed from the rows by the
    # entity (num_examples/kind_counts) and by the indexer (the other three).
    # Persist.TRUE: they ride the shadow index so `from_record` lifts them onto
    # the DB row; they are NOT header fields, so the manifest never carries them.
    num_examples: int = APIField(0, persist=Persist.TRUE)
    kind_counts: Dict[str, int] = APIField({}, persist=Persist.TRUE)
    num_annotated: int = APIField(0, persist=Persist.TRUE)
    num_multi_output: int = APIField(0, persist=Persist.TRUE)
    num_binary_inputs: int = APIField(0, persist=Persist.TRUE)

    # Free `data` section of dataset.json (use-case-owned passthrough).
    data: Optional[Dict[str, Any]] = APIField(default_factory=dict, persist=Persist.TRUE)

    created_at: Optional[datetime] = APIField(None)

    # Absolute path of the dataset folder on disk, stamped by the indexer /
    # ``Entity.from_fs_ref``. A plain string, not an FSRef. Mirrors WHITEBOARD.
    asset_ref: str = APIField(default="", sharing=Sharing.PRIVATE)

    @model_validator(mode="after")
    def _counts_follow_the_rows(self) -> "Dataset":
        """``num_examples`` / ``kind_counts`` are FACTS about ``examples`` —
        derived here, so an entity built from rows (a save) and one read from
        disk agree, and neither can carry a stale count."""
        if self.examples:
            from flow_sdk.assets.types.dataset import dataset_counts

            counts = dataset_counts(str(example.kind) for example in self.examples)
            self.num_examples = counts["num_examples"]
            self.kind_counts = counts["kind_counts"]
        return self

    def of_kind(self, kind: ExampleKind) -> List[ExampleSpec]:
        """'The eval set' is ``dataset.of_kind(ExampleKind.EVAL)``."""
        return [e for e in self.examples if e.kind == kind]

    # ── the curation seam: SourceItem → example → gold ───────────────────

    def _example_type(self) -> Any:
        """The declared example shape, compiled.

        ``spec`` holds the authoring FORM (it is a document field, so it is
        data); a class is built only here, where one is actually needed.
        ``DatasetSpec.parse`` rather than ``DataSpec.parse`` — a dataset form
        names ``examples``, not fields.
        """
        return DatasetSpec.parse(self.spec) if self.spec else DEFAULT_DATASET_SPEC

    @property
    def input_shape(self) -> Any:
        return self._example_type().example_type().input_type()

    @property
    def output_shape(self) -> Any:
        return self._example_type().example_type().output_type()

    @property
    def declared_kind(self) -> str:
        """The kind this dataset says it is (``navigator.dataset``) -- ``""`` for an inline shape."""
        return self.spec if isinstance(self.spec, str) else ""

    def _folder(self) -> Path:
        if not self.asset_ref:
            raise ValueError("dataset has no folder on disk yet")
        return Path(self.asset_ref)

    def _index(self) -> List[Dict[str, Any]]:
        """Per-example scalars from the folder — the cheap read (one
        ``example.json`` per dir), never the typed payloads."""
        from flow_sdk.schema.data_spec.layout import dataset_layout_for  # noqa: PLC0415

        if self.data_layout != DataLayoutEnum.IO_FOLDER or not self.asset_ref:
            return []
        return dataset_layout_for(self.data_layout).index(self._folder(), dataset_id=self.id)

    async def _counts_from_disk(self) -> "Dataset":
        """Re-derive the denormalized counts after a per-example write, and
        broadcast the row. A write changes only the counts, and those follow
        from the cheap index — re-parsing every example's payload (what a full
        reindex does) would make labelling N rows O(N²)."""
        rows = self._index()
        from flow_sdk.assets.types.dataset import dataset_counts

        counts = dataset_counts(row["kind"] for row in rows)
        self.num_examples = counts["num_examples"]
        # `annotated` is the layout's `has_ground_truth` — the rule the indexer's
        # `count_annotated` applies too, so a label and a reindex agree.
        self.num_annotated = sum(1 for row in rows if row["annotated"])
        self.kind_counts = counts["kind_counts"]
        await self.save()
        return self

    @action.get(action_name="examples")
    async def examples_action(self):
        """The rows as the disk holds them — id, the source item behind each,
        and whether it carries gold. What an editor needs to show promoted /
        labelled state without the DB-excluded ``examples`` field."""
        return ApiSuccessResponse(data={"examples": self._index()})

    async def promote(self, item_ids: list[str]) -> list[str]:
        """Items → example rows (``input/item.json`` + provenance). Returns the
        new example ids. Raises ``LookupError`` for an unknown item,
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
            contents, provenance = item.as_example_input()
            batch.append((
                ARTIFACT_ROW(
                    kind=ExampleKind.TRAIN,
                    input=FolderSpec(path=INPUT, files={"item.json": FileRef(path=f"{INPUT}/item.json")}),
                    metadata={"source": provenance},
                ),
                contents,
            ))
        return layout.append_many(self._folder(), batch, dataset_id=self.id)

    async def annotate(self, example_id: str, ground_truth: Any, *, by: str = "") -> None:
        """One example's gold label -- a value, or a LIST of acceptable answers -- validated against
        the output shape (``ValidationError``). It REPLACES any gold the example had. The gold of a
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
        dataset_layout_for(self.data_layout).annotate(
            self._folder(), example_id, payload, dataset_id=self.id, by=by,
            main=_main_document(shape) if named else ANNOTATION_FILE,
        )

    def set_data(self, example_id: str, data: dict) -> None:
        """Replace one example's free ``data`` (a suite tag, a note) -- its inputs and golds untouched."""
        from flow_sdk.schema.data_spec.layout import dataset_layout_for  # noqa: PLC0415

        dataset_layout_for(self.data_layout).set_data(self._folder(), example_id, dict(data), dataset_id=self.id)

    @property
    def row_type(self) -> Any:
        """The ``ExampleSpec`` every row of this dataset is -- typed when ``spec`` names its slots."""
        return self._example_type().example_type()

    def _typed_rows_or_raise(self) -> Any:
        row = self.row_type
        if row.input_type() is None:
            raise ValueError("this dataset declares no row shape (`spec`), so a row cannot be checked")
        if self.data_layout != DataLayoutEnum.IO_FOLDER:
            raise ValueError("typed rows are io_folder only")
        return row

    _ROW_KEYS = frozenset({"input", "context", "ground_truth", "output", "kind", "data"})

    def _row_in(self, raw: Any, n: int, *, keyed: bool = False) -> Any:
        """One incoming row as the declared row type -- ``ValueError`` for a malformed row,
        ``ValidationError`` for one that does not fit the shape."""
        if not isinstance(raw, dict) or "input" not in raw:
            raise ValueError(f"row {n}: an object with an `input` is required")
        unknown = set(raw) - self._ROW_KEYS - ({"key"} if keyed else set())
        if unknown:
            raise ValueError(f"row {n}: unknown keys {sorted(unknown)}")
        return self._typed_rows_or_raise().model_validate({k: v for k, v in raw.items() if k != "key"})

    async def append(self, rows: list[dict]) -> list[str]:
        """Typed rows in -- ``{input, context?, ground_truth?, output?, kind?, data?, key?}`` each,
        checked against the declared row shape BEFORE anything is written (one bad row writes nothing).

        The counterpart of ``promote`` for a dataset whose input is not a source item: a request, a
        prompt, anything the dataset's own spec defines. A row with a ``key`` lands in
        ``examples/<key>/`` (refused when the key is taken); the others are numbered. Returns the new
        example ids."""
        from flow_sdk.schema.data_spec.layout import dataset_layout_for  # noqa: PLC0415

        examples = [(self._row_in(raw, n, keyed=True), None) for n, raw in enumerate(rows, 1)]
        keys = [raw.get("key") for raw in rows]
        return dataset_layout_for(self.data_layout).append_many(
            self._folder(), examples, dataset_id=self.id, keys=keys)

    def check(self, row: dict) -> list[str]:
        """What is wrong with ``row`` as one row of this dataset -- ``[]`` when it fits. Writes nothing."""
        try:
            self._row_in(row, 1, keyed=True)
        except ValidationError as exc:
            return [f"{'.'.join(str(p) for p in e.get('loc', ()))}: {e.get('msg')}" for e in exc.errors(include_url=False)]
        except ValueError as exc:
            return [str(exc)]
        return []

    async def put(self, key: str, row: dict) -> str:
        """Write the row ``key`` -- create it, or replace the one there. Validated BEFORE anything is
        written. Slots the row leaves out (``ground_truth``, ``output``, ``context``) and the
        example's metadata (kind, annotations, source) are kept from the row it replaces, so editing
        an input never drops its gold. Returns the example id."""
        from flow_sdk.schema.data_spec.layout import FolderLayout, _load_example_meta, check_key  # noqa: PLC0415

        row_type, layout, folder = self._typed_rows_or_raise(), FolderLayout(), self._folder()
        if not isinstance(row, dict):
            raise ValueError("row: an object is required")
        old_dir = layout.example_dir(folder, check_key(key), dataset_id=self.id)
        merged: dict[str, Any] = {}
        metadata: dict[str, Any] = {}
        if old_dir is not None:
            metadata, merged["data"] = _load_example_meta(old_dir)
            merged["kind"] = metadata.pop("kind", None) or ExampleKind.TRAIN.value
            try:
                old = layout.read_typed(old_dir, row_type, dataset_id=self.id)
            except ValidationError:
                old = None   # a row that no longer fits is being repaired: keep only its metadata
            if old is not None:
                for slot in ("input", "context", "ground_truth", "output"):
                    value = getattr(old, slot)
                    if value is not None:
                        merged[slot] = value
        merged.update(row)
        example = self._row_in(merged, 1)
        if metadata:
            example = example.model_copy(update={"metadata": {**metadata, **example.metadata}})
        return layout.put_example(folder, key, example, dataset_id=self.id)

    def delete_row(self, key_or_id: str) -> str:
        """Remove one row. Returns its key; ``LookupError`` when there is none."""
        from flow_sdk.schema.data_spec.layout import FolderLayout  # noqa: PLC0415

        self._typed_rows_or_raise()
        return FolderLayout().delete_example(self._folder(), key_or_id, dataset_id=self.id)

    def rename_row(self, key_or_id: str, new_key: str) -> str:
        """Give one row a new key. Its id follows the key: the NEW id is returned, and anything that
        pointed at the old key or id must be updated by the caller."""
        from flow_sdk.schema.data_spec.layout import FolderLayout  # noqa: PLC0415

        self._typed_rows_or_raise()
        return FolderLayout().rename_example(self._folder(), key_or_id, new_key, dataset_id=self.id)

    def example(self, example_id: str) -> Optional[dict]:
        """One example with its slots' VALUES (not paths) -- what an editor shows. None if absent."""
        from flow_sdk.schema.data_spec.layout import FolderLayout  # noqa: PLC0415

        row_type = self._typed_rows_or_raise()
        layout = FolderLayout()
        ex_dir = layout.example_dir(self._folder(), example_id, dataset_id=self.id)
        if ex_dir is None:
            return None
        row = layout.read_typed(ex_dir, row_type, dataset_id=self.id)
        return None if row is None else row.model_dump(mode="json")

    def validate_rows(self) -> list[dict]:
        """Every row read as the declared shape: ``[{example_id, error}]`` for the rows that do not
        fit. Indexing reads rows as artifacts on purpose (fast, never fatal); this is the check."""
        from flow_sdk.schema.data_spec.layout import (  # noqa: PLC0415
            FolderLayout,
            _example_dirs,
            _ReadShape,  # noqa: PLC0415
            example_id,
        )

        row_type = self._typed_rows_or_raise()
        layout, problems, shape = FolderLayout(), [], _ReadShape.of(row_type)
        for ex_dir in _example_dirs(self._folder()):
            try:
                layout.read_typed(ex_dir, row_type, dataset_id=self.id, shape=shape)
            except ValidationError as exc:
                first = exc.errors(include_url=False)[0]
                where = ".".join(str(p) for p in first.get("loc", ()))
                problems.append({"example_id": example_id(self.id, ex_dir.name), "error": f"{where}: {first.get('msg')}"})
        return problems

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

    @action.get(action_name="rows")
    async def rows_action(self):
        """Every example with its slots' VALUES, in one read -- what an editor shows on open."""
        try:
            return ApiSuccessResponse(data={"rows": [r.model_dump(mode="json") for r in self.read_rows()]})
        except (ValueError, ValidationError) as exc:
            return ApiFailResponse(message=str(exc), status_code=400)

    @action.post(action_name="score")
    async def score_action(self):
        """Recorded outputs scored against the gold → ``{rows, scored, correct, accuracy, wrong}``."""
        try:
            return ApiSuccessResponse(data=self.score())
        except (ValueError, ValidationError) as exc:
            return ApiFailResponse(message=str(exc), status_code=400)

    @action.post(action_name="append")
    async def append_action(self):
        """``{"rows": [...]}`` → ``{"example_ids", "num_examples"}``; a row that does not fit is a 400
        naming it, and nothing is written."""
        body = await read_json_body(get_current_request_info())
        if isinstance(body, ApiFailResponse):
            return body
        rows = body.get("rows")
        if not isinstance(rows, list) or not rows:
            return ApiFailResponse(message="rows: a non-empty list is required", status_code=400)
        try:
            ids = await self.append(rows)
        except ValidationError as exc:
            return ApiFailResponse(message="a row does not match the dataset's shape", status_code=400,
                                   data={"errors": exc.errors(include_url=False)})
        except ValueError as exc:
            return ApiFailResponse(message=str(exc), status_code=400)
        fresh = await self._counts_from_disk()
        return ApiSuccessResponse(data={"example_ids": ids, "num_examples": fresh.num_examples})

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
        """``{"key", "row"}`` → ``{"example_id", "key", "num_examples"}``: create or replace the row
        ``key``. A row that does not fit is a 400 and nothing is written."""
        body = await self._row_body("key", "row")
        if isinstance(body, ApiFailResponse):
            return body
        try:
            eid = await self.put(body["key"], body["row"])
        except ValidationError as exc:
            return ApiFailResponse(message="the row does not match the dataset's shape", status_code=400,
                                   data={"errors": exc.errors(include_url=False)})
        except ValueError as exc:
            return ApiFailResponse(message=str(exc), status_code=400)
        fresh = await self._counts_from_disk()
        return ApiSuccessResponse(data={"example_id": eid, "key": body["key"], "num_examples": fresh.num_examples})

    @action.post(action_name="delete-row")
    async def delete_row_action(self):
        """``{"key"}`` (a key or an example id) → ``{"key", "num_examples"}``; 404 when absent."""
        body = await self._row_body("key")
        if isinstance(body, ApiFailResponse):
            return body
        try:
            key = self.delete_row(body["key"])
        except LookupError as exc:
            return ApiFailResponse(message=str(exc), status_code=404)
        except ValueError as exc:
            return ApiFailResponse(message=str(exc), status_code=400)
        fresh = await self._counts_from_disk()
        return ApiSuccessResponse(data={"key": key, "num_examples": fresh.num_examples})

    @action.post(action_name="rename-row")
    async def rename_row_action(self):
        """``{"key", "new_key"}`` → ``{"example_id", "key"}`` -- the row's NEW id and key."""
        body = await self._row_body("key", "new_key")
        if isinstance(body, ApiFailResponse):
            return body
        try:
            eid = self.rename_row(body["key"], body["new_key"])
        except LookupError as exc:
            return ApiFailResponse(message=str(exc), status_code=404)
        except ValueError as exc:
            return ApiFailResponse(message=str(exc), status_code=400)
        return ApiSuccessResponse(data={"example_id": eid, "key": body["new_key"]})

    @action.post(action_name="check-row")
    async def check_row_action(self):
        """``{"row"}`` → ``{"ok", "errors"}``: would this row fit? Nothing is written."""
        body = await self._row_body("row")
        if isinstance(body, ApiFailResponse):
            return body
        try:
            errors = self.check(body["row"])
        except ValueError as exc:   # the dataset itself cannot take typed rows
            return ApiFailResponse(message=str(exc), status_code=400)
        return ApiSuccessResponse(data={"ok": not errors, "errors": errors})

    @action.get(action_name="example")
    async def example_action(self):
        """``GET example/<example_id>`` → the example with its slots' values."""
        request_info = get_current_request_info()
        example_id = ((request_info.sub_path or "") if request_info else "").strip("/")
        if not example_id:
            return ApiFailResponse(message="example id required: example/<example_id>", status_code=400)
        try:
            found = self.example(example_id)
        except ValueError as exc:
            return ApiFailResponse(message=str(exc), status_code=400)
        except ValidationError as exc:
            return ApiFailResponse(message="the example does not match the dataset's shape", status_code=422,
                                   data={"errors": exc.errors(include_url=False)})
        if found is None:
            return ApiFailResponse(message=f"no example {example_id}", status_code=404)
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
        """``GET eval/<run_id>`` → ``{run, examples, count_metrics, explain}``: the ``EvalRun`` and every
        ``ExampleEval``, each joined to its example's ``input`` / ``context`` / ``data`` / ``kind`` -- so
        a browser drills down to what was typed, where, and what was offered, without a second request.
        A trace (how an answer was reached, ~7 KB each) is left out of the listing: only the example a
        person opens needs one -- ``GET eval/<run_id>/<example_id>`` → ``{trace}``."""
        from flow_sdk.evals import store  # noqa: PLC0415

        request_info = get_current_request_info()
        run_id, _, example_id = ((request_info.sub_path or "") if request_info else "").strip("/").partition("/")
        if not run_id:
            return ApiFailResponse(message="run id required: eval/<run_id>", status_code=400)
        try:
            run, examples = await asyncio.to_thread(store.load, self._folder(), run_id)
        except LookupError as exc:
            return ApiFailResponse(message=str(exc), status_code=404)
        if example_id:
            found = next((ex for ex in examples if ex.example_id == example_id), None)
            if found is None:
                return ApiFailResponse(message=f"no example {example_id} in run {run_id}", status_code=404)
            return ApiSuccessResponse(data={"trace": found.trace.model_dump(mode="json") if found.trace else None})

        def read_rows() -> dict:
            try:
                return {r.id: r for r in self.read_rows()}
            except (ValueError, ValidationError):
                return {}

        rows, explain = await asyncio.gather(
            asyncio.to_thread(read_rows), asyncio.to_thread(store.explanations, self._folder(), self.declared_kind)
        )
        joined = []
        for ex in examples:
            row = rows.get(ex.example_id)
            dumped = row.model_dump(mode="json", include={"input", "context", "data", "kind"}) if row else {}
            # A logged row keeps its own run's trace in its data -- not this eval's; it stays home too.
            if isinstance(dumped.get("data"), dict):
                dumped["data"].pop("run", None)
            joined.append({**ex.model_dump(mode="json", exclude={"trace"}), **{f"row_{k}": v for k, v in dumped.items()}})
        return ApiSuccessResponse(
            data={
                "run": run.model_dump(mode="json"),
                "examples": joined,
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
        fresh = await self._counts_from_disk()
        return ApiSuccessResponse(data={"checked": fresh.num_examples, "problems": problems})

    @action.post(action_name="promote")
    async def promote_action(self):
        """``{"source_item_ids": [...]}`` → ``{"example_ids": [...], "num_examples"}``."""
        body = await read_json_body(get_current_request_info())
        if isinstance(body, ApiFailResponse):
            return body
        ids = body.get("source_item_ids")
        if not isinstance(ids, list) or not ids:
            return ApiFailResponse(message="source_item_ids: a non-empty list is required", status_code=400)
        try:
            example_ids = await self.promote(ids)
        except LookupError as exc:
            return ApiFailResponse(message=str(exc), status_code=404)
        except (ValueError, NotImplementedError) as exc:
            return ApiFailResponse(message=str(exc), status_code=400)
        fresh = await self._counts_from_disk()
        return ApiSuccessResponse(data={"example_ids": example_ids, "num_examples": fresh.num_examples})

    @action.post(action_name="annotate")
    async def annotate_action(self):
        """``{"example_id", "ground_truth"}`` → ``{"example_id", "num_annotated"}``;
        a shape mismatch is a 400 carrying the output JSON schema."""
        from pydantic import TypeAdapter  # noqa: PLC0415

        body = await read_json_body(get_current_request_info())
        if isinstance(body, ApiFailResponse):
            return body
        example_id = str(body.get("example_id") or "")
        if not example_id or "ground_truth" not in body:
            return ApiFailResponse(message="example_id and ground_truth are required", status_code=400)
        try:
            await self.annotate(example_id, body["ground_truth"], by=current_user_id())
        except ValidationError as exc:
            return ApiFailResponse(
                message="ground_truth does not match the dataset's output shape", status_code=400,
                data={"errors": exc.errors(include_url=False), "schema": TypeAdapter(self.output_shape).json_schema()},
            )
        except LookupError as exc:
            return ApiFailResponse(message=str(exc), status_code=404)
        except NotImplementedError as exc:
            return ApiFailResponse(message=str(exc), status_code=400)
        fresh = await self._counts_from_disk()
        return ApiSuccessResponse(data={"example_id": example_id, "num_annotated": fresh.num_annotated})
