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
from flow_sdk.core import Entity
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



def dataset_id_from_path(path: Path) -> str:
    """Stable id derived from the resolved folder path. THE one definition — the
    indexer's identity reader imports it, so a direct load and a walk agree."""
    import uuid  # noqa: PLC0415

    from flow_sdk.fs_store.identifier import mint_uuid  # noqa: PLC0415

    return mint_uuid(f"dataset:{Path(path).resolve()}", namespace=uuid.NAMESPACE_DNS)
