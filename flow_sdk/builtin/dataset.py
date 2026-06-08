"""``Dataset`` — a folder-backed collection of examples for eval & training.

A dataset holds many ``Example`` rows in one of two physical layouts (see
``DataLayoutEnum``):

- ``CSV``        — a single ``data.csv`` file; each row is an example.
- ``IO_FOLDER``  — an ``examples/`` folder where each example dir carries
  ``input`` / ``output`` / ``ground_truth`` slots (file, folder, or numbered
  occurrences) plus ``«slot».json`` metadata sidecars and an ``example.json``.
  Legacy ``input.txt`` / ``expected.txt`` are still accepted.

The container is the entity; an ``Example`` is a plain Pydantic row parsed from
disk on demand (a 50k-row CSV stays one record, not 50k entities). The
train/eval/test split lives *per-example* as ``Example.kind`` — "the eval set"
is simply ``dataset.examples(ExampleKind.EVAL)``.

The walker + parser + id-mint slot functions live in
``flow_sdk/fs_store/indexer/functions/dataset.py``; the type registration lives
in ``flow_sdk/schema/type_info/dataset_type_info.py``. Modeled on WHITEBOARD.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel

from flow_sdk._compat import StrEnum
from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity


class DataLayoutEnum(StrEnum):
    """How a dataset's examples are physically stored on disk."""

    CSV = "csv"               # one delimited file; each row is an Example
    IO_FOLDER = "io_folder"   # a folder of per-example input/expected pairs


class ExampleKind(StrEnum):
    """Per-example role. 'The eval set' = examples whose kind == EVAL."""

    TRAIN = "train"
    EVAL = "eval"
    TEST = "test"


class ArtifactKind(StrEnum):
    """Whether a slot artifact is a single file or a folder of files."""

    FILE = "file"
    FOLDER = "folder"


class ExampleArtifact(BaseModel):
    """One occurrence of a slot — a single file, or one folder of files.

    Carries RELATIVE (POSIX) paths under the example dir so binary inputs
    (PDFs/images) are referenced lazily and never eagerly read. ``text`` is
    populated ONLY for small text FILE artifacts (``.txt``/``.md``); it stays
    None for binary files and for folders. ``index`` is the ``N`` in
    ``output-2`` (None for the bare, unindexed occurrence).
    """

    kind: ArtifactKind
    path: str                           # rel POSIX path: "input.pdf", "output-1", ...
    files: List[str] = []               # FOLDER: contained file rel-paths (sorted); FILE: [path]
    text: Optional[str] = None          # decoded only for .txt/.md FILE artifacts; else None
    index: Optional[int] = None         # N in "output-2"; None for the bare artifact
    metadata: Dict[str, Any] = {}       # from the sibling «base»[-N].json sidecar
    id: str = ""                        # deterministic uuid5


class ExampleSlot(BaseModel):
    """All occurrences of one slot base-name (``input``/``output``/``ground_truth``).

    ``artifacts`` is ordered: the bare occurrence (``index`` None) first, then
    numbered occurrences ascending. ``metadata`` holds a bare ``«base».json``
    sidecar that has no matching data artifact (slot-level metadata).
    """

    name: str                           # "input" | "output" | "ground_truth"
    artifacts: List["ExampleArtifact"] = []
    metadata: Dict[str, Any] = {}

    @property
    def primary(self) -> Optional["ExampleArtifact"]:
        return self.artifacts[0] if self.artifacts else None


class Example(BaseModel):
    """One row of a dataset. Parsed from disk on demand; NOT a tracked Entity.

    ``id`` is a deterministic uuid5 of ``f"{dataset_id}:{key}"`` (the row index
    for CSV, the example folder name for IO_FOLDER) so promotion to a real
    entity later is idempotent.

    ``input``/``expected`` are back-compat scalar views (the single-text-file
    case); the structured ``*_slot`` fields carry the full picture for folder,
    binary, numbered-multiple, and sidecar-annotated artifacts.
    """

    id: str
    kind: ExampleKind = ExampleKind.TRAIN
    input: str = ""                     # back-compat: input.txt/.md text, else "" (folder/binary)
    expected: Optional[str] = None      # back-compat: ground_truth primary text (None ⇒ unlabeled)
    metadata: Dict[str, Any] = {}

    # Structured slots — empty for CSV and legacy text-only IO_FOLDER examples.
    input_slot: Optional[ExampleSlot] = None
    output_slot: Optional[ExampleSlot] = None       # candidate/produced data — never the gold
    ground_truth_slot: Optional[ExampleSlot] = None  # the gold; multiple artifacts ⇒ consensus
    layout: Optional[str] = None        # per-example hint from example.json["layout"]


class Dataset(Entity):
    type: str = APIField(default="dataset")
    title: str = APIField("")
    description: Optional[str] = APIField(None, blob=True)

    # Physical layout discriminator + CSV-only knobs.
    data_layout: str = APIField(DataLayoutEnum.CSV)
    # FieldSpec-style column mapping so an arbitrary CSV maps onto the canonical
    # Example shape without reshaping the file: {"question": "input"}.
    field_spec: Dict[str, str] = APIField({})
    delimiter: str = APIField(",")

    # Denormalized counts surfaced in lists (computed by extract_dataset).
    num_examples: int = APIField(0)
    kind_counts: Dict[str, int] = APIField({})

    created_at: Optional[datetime] = APIField(None)

    def examples(self, kind: Optional[ExampleKind] = None) -> List[Example]:
        """Lazily parse the dataset's rows from disk, optionally filtered by kind.

        Reads from ``self.asset_ref`` (the dataset folder). 'The eval set' is
        ``dataset.examples(ExampleKind.EVAL)`` — the same call regardless of
        whether the dataset is a CSV or an IO_FOLDER, because ``iter_examples``
        normalizes both into the same ``Example`` shape.
        """
        from flow_sdk.fs_store.indexer.functions.dataset import iter_examples

        base = getattr(self, "asset_ref", None)
        if not base:
            return []
        rows = iter_examples(
            str(base),
            DataLayoutEnum(self.data_layout),
            self.field_spec or {},
            self.delimiter or ",",
            dataset_id=self.id,
        )
        return [e for e in rows if kind is None or e.kind == kind]
