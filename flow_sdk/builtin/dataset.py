"""``Dataset`` — a folder-backed collection of examples for eval & training.

A dataset holds many ``Example`` rows in one of two physical layouts (see
``DataLayoutEnum``):

- ``CSV``        — a single ``data.csv`` file; each row is an example.
- ``IO_FOLDER``  — an ``examples/`` folder where each example dir carries
  ``input`` / ``output`` / ``ground_truth`` slots (file, folder, or numbered
  occurrences) plus ``«slot».json`` metadata sidecars and an ``example.json``.
  Legacy ``input.txt`` / ``expected.txt`` are still accepted.

Either layout parses into the same shape: one plain-JSON row per example. The
row mirrors the example directory — a file is a ``str`` path, a folder is a
``dict`` of members, a sidecar is a sibling ``{"metadata", "data"}`` dict — so
there is one representation of a row's content, and it is the JSON itself. The
dataset ``spec`` (a :class:`DataSpec`) is what says which strings are paths.

Every dataset JSON file (``dataset.json``, ``example.json``, ``«slot».json``) is a
two-section document — ``{"metadata": {...}, "data": {...}}``. ``metadata`` holds
flowpad-managed known fields (parsed into typed attributes); ``data`` is a free
object the use case owns. Both are surfaced on the carrier models below.

The container is the entity; an ``Example`` is a plain Pydantic row parsed from
disk on demand (a 50k-row CSV stays one record, not 50k entities). The
train/eval/test split lives *per-example* as ``Example.kind`` — "the eval set"
is simply ``dataset.examples(ExampleKind.EVAL)``.

The walker + parser live in
``flow_sdk/fs_store/indexer/functions/dataset.py``; the type registration lives
in ``flow_sdk/schema/type_info/dataset_type_info.py``. Modeled on WHITEBOARD.
"""
from __future__ import annotations

import logging
from datetime import datetime
from pathlib import Path
from typing import Annotated, Any, Dict, List, Optional

from pydantic import BeforeValidator, PlainSerializer, ValidationError, model_validator

from flow_sdk.api.api_types.api_field import APIField, NoDBAPIField, Persist, Sharing
from flow_sdk.core import Entity, action
from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp
from flow_sdk.request_context.json_body import current_user_id, read_json_body
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse
from flow_sdk.schema.data_spec import FreeSection, FrontMatter, to_authoring_form
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

logger = logging.getLogger(__name__)

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
DatasetSpecType = Annotated[type, BeforeValidator(DatasetSpec.parse), PlainSerializer(to_authoring_form, return_type=Any)]

class DatasetManifestSpec(FrontMatter):
    """The ``metadata`` section of ``dataset.json`` — the fields a human authors.
    The denormalized counts are NOT here: the indexer computes them from the
    rows, and writing them back would make the manifest lie after an append.

    A malformed ``spec`` ON DISK degrades the SLOT, never the dataset: raising
    would cost every example row, and an ``orphan_action=DELETE`` sweep would
    then reap rows that parsed fine. That is a disk-read policy — the entity
    field itself is strict — so it lives here, at the header read.
    """

    @model_validator(mode="before")
    @classmethod
    def _lenient_spec(cls, values: Any) -> Any:
        raw = values.get("spec") if isinstance(values, dict) else None
        if raw is None or isinstance(raw, type):
            return values
        try:
            DatasetSpec.parse(raw)
        except (ValueError, ValidationError) as exc:
            logger.warning("[dataset] ignoring malformed `spec`: %s", exc)
            return {k: v for k, v in values.items() if k != "spec"}
        return values

    title: Optional[str] = None
    description: Optional[str] = None
    #: The DataSource whose items this dataset curates (empty when hand-authored).
    source_id: Optional[str] = None
    data_layout: Optional[str] = None
    field_spec: Optional[Dict[str, str]] = None
    delimiter: Optional[str] = None
    spec: Optional[DatasetSpecType] = None
    #: The free ``data`` section of ``dataset.json`` — the document's second half.
    data: Optional[FreeSection] = None


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
    spec: Optional[DatasetSpecType] = APIField(None)

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
            counts: Dict[str, int] = {}
            for ex in self.examples:
                counts[ex.kind.value] = counts.get(ex.kind.value, 0) + 1
            self.num_examples = len(self.examples)
            self.kind_counts = counts
        return self

    def of_kind(self, kind: ExampleKind) -> List[ExampleSpec]:
        """'The eval set' is ``dataset.of_kind(ExampleKind.EVAL)``."""
        return [e for e in self.examples if e.kind == kind]

    # ── the curation seam: SourceItem → example → gold ───────────────────

    @property
    def input_shape(self) -> Any:
        return (self.spec or DEFAULT_DATASET_SPEC).example_type().input_type()

    @property
    def output_shape(self) -> Any:
        return (self.spec or DEFAULT_DATASET_SPEC).example_type().output_type()

    def _folder(self) -> Path:
        if not self.asset_ref:
            raise ValueError("dataset has no folder on disk yet")
        return Path(self.asset_ref)

    def _index(self) -> List[Dict[str, Any]]:
        """Per-example scalars from the folder — the cheap read (one
        ``example.json`` per dir), never the typed payloads."""
        from flow_sdk.schema.data_spec.layout import layout_for  # noqa: PLC0415

        if self.data_layout != DataLayoutEnum.IO_FOLDER or not self.asset_ref:
            return []
        return layout_for(self.data_layout).index(self._folder(), dataset_id=self.id)

    async def _counts_from_disk(self) -> "Dataset":
        """Re-derive the denormalized counts after a per-example write, and
        broadcast the row. A write changes only the counts, and those follow
        from the cheap index — re-parsing every example's payload (what a full
        reindex does) would make labelling N rows O(N²)."""
        rows = self._index()
        kinds: Dict[str, int] = {}
        for row in rows:
            kinds[row["kind"]] = kinds.get(row["kind"], 0) + 1
        self.num_examples = len(rows)
        self.num_annotated = sum(1 for row in rows if row["annotated"])
        self.kind_counts = kinds
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
        from flow_sdk.builtin.source_item import SourceItem, SourceItemSpec  # noqa: PLC0415
        from flow_sdk.schema.data_spec.dataset_spec import FileRef, FolderSpec  # noqa: PLC0415
        from flow_sdk.schema.data_spec.layout import INPUT, layout_for  # noqa: PLC0415

        if self.input_shape is not SourceItemSpec:
            raise ValueError('this dataset does not take source items — its spec input must be "ingest.source_item"')
        layout = layout_for(self.data_layout)   # a CSV layout refuses `append` itself
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
        """One example's gold label, validated against the output shape
        (``ValidationError``) and written as ``ground_truth/label.json``."""
        from pydantic import TypeAdapter  # noqa: PLC0415

        from flow_sdk.schema.data_spec.layout import layout_for  # noqa: PLC0415

        gold = TypeAdapter(self.output_shape).validate_python(ground_truth)
        payload = gold.model_dump(mode="json") if hasattr(gold, "model_dump") else gold
        layout_for(self.data_layout).annotate(self._folder(), example_id, payload, dataset_id=self.id, by=by)

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


def dataset_id_from_path(path: Path) -> str:
    """Stable id derived from the resolved folder path. THE one definition — the
    indexer's identity reader imports it, so a direct load and a walk agree."""
    import uuid  # noqa: PLC0415

    from flow_sdk.api.api_types.identifier import mint_uuid  # noqa: PLC0415

    return mint_uuid(f"dataset:{Path(path).resolve()}", namespace=uuid.NAMESPACE_DNS)
