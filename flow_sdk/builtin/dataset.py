"""``Dataset`` — a folder-backed collection of examples for eval & training.

A dataset holds many ``Example`` rows in one of two physical layouts (see
``DataLayoutEnum``):

- ``CSV``        — a single ``data.csv`` file; each row is an example.
- ``IO_FOLDER``  — an ``examples/`` folder of per-example ``input``/``expected``
  pairs.

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


class Example(BaseModel):
    """One row of a dataset. Parsed from disk on demand; NOT a tracked Entity.

    ``id`` is a deterministic uuid5 of ``f"{dataset_id}:{key}"`` (the row index
    for CSV, the example folder name for IO_FOLDER) so promotion to a real
    entity later is idempotent.
    """

    id: str
    kind: ExampleKind = ExampleKind.TRAIN
    input: str
    expected: Optional[str] = None      # target / ideal / ground-truth (None ⇒ unlabeled)
    metadata: Dict[str, Any] = {}


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
