"""``Dataset`` — a folder-backed collection of examples for eval & training.

A dataset holds many ``Example`` rows in one of two physical layouts (see
``DataLayoutEnum``):

- ``CSV``        — a single ``data.csv`` file; each row is an example.
- ``IO_FOLDER``  — an ``examples/`` folder where each example dir carries
  ``input`` / ``output`` / ``ground_truth`` slots (file, folder, or numbered
  occurrences) plus ``«slot».json`` metadata sidecars and an ``example.json``.
  Legacy ``input.txt`` / ``expected.txt`` are still accepted.

Either layout parses into the same shape: one :class:`Datum` tree per row. The
tree mirrors the example directory — a file is a leaf, a folder is a branch, a
sidecar is a sibling leaf — so there is one representation of a row's content
rather than a slot model plus two back-compat scalars.

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

from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel

from flow_sdk._compat import StrEnum
from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.core import Entity
from flow_sdk.schema.datum import Datum

# Canonical per-example metadata filename inside an IO_FOLDER example dir.
# Owned here (the model module) so writers (GraphWorkflowManager's born-compatible
# example stamps) and the indexer's reader agree by construction.
EXAMPLE_META = "example.json"


class DataLayoutEnum(StrEnum):
    """How a dataset's examples are physically stored on disk."""

    CSV = "csv"               # one delimited file; each row is an Example
    IO_FOLDER = "io_folder"   # a folder of per-example input/expected pairs


class ExampleKind(StrEnum):
    """Per-example role. 'The eval set' = examples whose kind == EVAL."""

    TRAIN = "train"
    EVAL = "eval"
    TEST = "test"


class Example(BaseModel):
    """One row of a dataset. Parsed from disk on demand; NOT a tracked Entity.

    ``id`` is a deterministic uuid5 of ``f"{dataset_id}:{key}"`` (the row index
    for CSV, the example folder name for IO_FOLDER) so promotion to a real
    entity later is idempotent.

    ``datum`` is the row's content, as a :class:`~flow_sdk.schema.datum.Datum`
    tree that mirrors the example directory: a file is a leaf whose ``value`` is
    its example-relative POSIX path, a folder is a branch of its members, and a
    ``«slot»[-N].json`` sidecar is an ordinary sibling leaf keyed by its full
    filename. Sidecar keys can never collide with data keys — a data key is a
    filename STEM (no dot), a sidecar key always carries one.

    A CSV row builds the same tree with literal values instead of paths; the
    ``content.file`` kind on a leaf is what tells the two apart.
    """

    id: str
    kind: ExampleKind = ExampleKind.TRAIN
    metadata: Dict[str, Any] = {}       # example.json `metadata` section (kind/layout lifted from here)
    data: Dict[str, Any] = {}           # example.json `data` section (free, use-case-owned)
    datum: Datum = Datum()              # the row's content tree
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

    # Free `data` section of dataset.json (use-case-owned passthrough). The
    # other known metadata fields ride in the record metadata.
    data: Optional[Dict[str, Any]] = APIField(default_factory=dict)

    # The shape each example's `datum` populates: a `Datum` with EMPTY leaves.
    # `None` — the dataset declares no shape — is legal. See datasets.md.
    contract: Optional[Datum] = APIField(None)

    created_at: Optional[datetime] = APIField(None)

    # Absolute path of the dataset folder on disk, stamped by the indexer /
    # ``Entity.from_fs_ref`` so ``examples()`` can lazily parse rows. A plain
    # string (not an FSRef) because ``examples()`` does ``str(asset_ref)`` to get
    # the path. Mirrors WHITEBOARD/COMMAND.
    asset_ref: str = APIField(default="", sharing=Sharing.PRIVATE)

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
