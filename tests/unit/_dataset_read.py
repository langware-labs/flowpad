"""The untyped dataset read the tests check layouts with: every row as ``DEFAULT_DATASET_SPEC``'s row
type. Production reads through ``Dataset`` (``flow_sdk/schema/data_spec/layout.py`` holds the grammar)."""

from __future__ import annotations

from pathlib import Path

from flow_sdk.schema.data_spec.dataset_spec import DEFAULT_DATASET_SPEC, DataLayoutEnum, RowSpec
from flow_sdk.schema.data_spec.layout import dataset_layout_for


def iter_rows(base: str | Path, layout: DataLayoutEnum, field_spec: dict[str, str], delimiter: str, *,
              dataset_id: str) -> list[RowSpec]:
    return dataset_layout_for(layout).read(
        Path(base), DEFAULT_DATASET_SPEC.row_type(), dataset_id=dataset_id, field_spec=field_spec, delimiter=delimiter,
    )
