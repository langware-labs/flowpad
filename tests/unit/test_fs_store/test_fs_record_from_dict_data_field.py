"""``FSRecord.from_dict`` on a flat record that has a ``data`` field of its own.

A dataset carries ``data`` (its ``dataset.json`` free section). Once the server saved one -- every
row write does -- its shadow ``metadata.json`` held ``"data": {}``, and ``from_dict`` took that for
the legacy wrapped shape: it unwrapped to an empty record, so ``destroy()`` removed nothing and
deleting the project left the dataset behind (found by the data-management probe on a live instance).
"""

from __future__ import annotations

import pytest

from flow_sdk.fs_store import FSRecord

pytestmark = pytest.mark.timeout(5)

DATASET_ID = "63e6d33e-31bc-4afe-9c3f-6297e773cf6b"


def test_a_flat_record_with_a_data_field_keeps_its_identity():
    rec = FSRecord.from_dict({"type": "dataset", "id": DATASET_ID, "data": {}, "project_id": "p"})
    assert (rec.type, rec.id) == ("dataset", DATASET_ID)
    assert rec.shadow_dir.name == DATASET_ID


def test_the_legacy_wrapped_shape_still_unwraps():
    rec = FSRecord.from_dict({"meta": {}, "data": {"type": "task", "id": DATASET_ID, "title": "t"}})
    assert (rec.type, rec.id) == ("task", DATASET_ID)
