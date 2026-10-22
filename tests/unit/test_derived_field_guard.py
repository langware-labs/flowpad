"""Derived fields: one deriver each, and a direct write is caught.

A persisted field is authored, identity, or DERIVED. A derived field is a fact
computed by exactly one function (``derived_writer`` / ``projection_writer``);
any other writer is the stale-counter bug class. ``derived_fields`` warn on a
direct write while ``REFUSE_DERIVED_WRITES`` is off and raise once it is on;
``projected_fields`` always raise.
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from flow_sdk.datasets.stores import rows_root_of
from flow_sdk.assets.types.dataset import derive_counts, derive_dataset
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.dataset import Dataset
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.builtin.message_thread import MessageThread
from flow_sdk.builtin.tab import Tab
from flow_sdk.core.entity import projected_fields as guard
from flow_sdk.schema.data_spec.dataset_spec import DataLayoutEnum
from flow_sdk.schema.data_spec.layout import dataset_layout_for
from flow_sdk.schema.data_spec.message_sender_spec import MessageSender
from tests.unit._dataset_read import iter_rows

GUARDED = [Conversation, MessageThread, Dataset, Tab]
DATASET_COUNTERS = {"num_rows", "kind_counts", "num_annotated", "num_multi_output", "num_binary_inputs"}


@pytest.mark.parametrize("cls", GUARDED, ids=lambda c: c.__name__)
def test_every_derived_field_names_one_deriver(cls):
    names = guard.derived_field_names(cls)
    assert names and names <= set(cls.model_fields), names - set(cls.model_fields)
    if cls.projected_fields:
        assert cls.projection_writer and cls.projection_writer != "the projection writer"
    if cls.derived_fields:
        assert cls.derived_writer, f"{cls.__name__} declares derived fields with no deriver"
    assert not (cls.projected_fields & cls.derived_fields)


def test_the_known_derived_fields_are_declared():
    assert DATASET_COUNTERS <= Dataset.derived_fields
    assert {"target_type", "target_id"} <= Tab.derived_fields
    assert "message_count" in MessageThread.projected_fields
    assert {"message_count", "unread_count", "is_unread", "archived"} <= Conversation.projected_fields


@pytest.mark.parametrize(("cls", "field", "value"), [
    (Dataset, "num_multi_output", 3),
    (Tab, "target_type", "markdown"),
], ids=["dataset", "tab"])
def test_a_direct_write_warns_then_refuses(cls, field, value, monkeypatch):
    warned: list[str] = []
    monkeypatch.setattr(guard.service_log, "warn", lambda msg, **_: warned.append(msg))
    entity = cls()
    setattr(entity, field, value)
    assert getattr(entity, field) == value
    assert warned and field in warned[0] and cls.derived_writer in warned[0]

    monkeypatch.setattr(guard, "REFUSE_DERIVED_WRITES", True)
    with pytest.raises(AttributeError, match="derived"):
        setattr(entity, field, value)


def test_the_deriver_writes_silently(monkeypatch):
    warned: list[str] = []
    monkeypatch.setattr(guard.service_log, "warn", lambda msg, **_: warned.append(msg))
    monkeypatch.setattr(guard, "REFUSE_DERIVED_WRITES", True)
    ds = Dataset()
    ds._write_derived(num_rows=2, num_binary_inputs=1)
    assert (ds.num_rows, ds.num_binary_inputs, warned) == (2, 1, [])


def test_inbound_bodies_drop_derived_fields():
    ds = Dataset()
    ds.apply_field_updates({"title": "t", "num_rows": 99})
    assert (ds.title, ds.num_rows) == ("t", 0)


# ── counters: one deriver, same answer on the row-write path and a reindex ──

def _row(ds: Path, name: str, files: dict[str, str]) -> None:
    ex = rows_root_of(ds) / "rows" / name
    ex.mkdir(parents=True)
    for rel, body in files.items():
        (ex / rel).parent.mkdir(parents=True, exist_ok=True)
        (ex / rel).write_text(body)


def _seed(root: Path) -> Path:
    ds = root / "ds"
    ds.mkdir(parents=True)
    (ds / "dataset.json").write_text(json.dumps({"metadata": {"data_layout": "io_folder"}, "data": {}}))
    _row(ds, "0001", {"input.txt": "a", "output-1.txt": "x", "output-2.txt": "y"})       # multi output
    _row(ds, "0002", {"input.png": "png", "ground_truth.txt": "g"})                      # binary input
    _row(ds, "0003", {"input/a.txt": "folder", "output.txt": "x"})                         # folder input
    _row(ds, "0004", {"input.txt": "b"})
    return ds


def _reindex(ds: Path) -> dict:
    data = {"data_layout": "io_folder", "rows": iter_rows(rows_root_of(ds), DataLayoutEnum.IO_FOLDER, {}, ",", dataset_id="d")}
    derive_dataset(data, ds, {})
    return {k: data[k] for k in DATASET_COUNTERS}


async def _refreshed(ds: Path, monkeypatch) -> dict:
    async def _no_save(self, *a, **k):
        return self

    monkeypatch.setattr(Dataset, "save", _no_save)
    entity = Dataset(id="d", data_layout=DataLayoutEnum.IO_FOLDER, asset_ref=str(ds))
    await entity.refresh_counts()
    return {k: getattr(entity, k) for k in DATASET_COUNTERS}


async def test_refresh_counts_matches_a_reindex_through_row_writes(tmp_path, monkeypatch):
    ds = _seed(tmp_path)
    first = _reindex(ds)
    assert (first["num_rows"], first["num_multi_output"], first["num_binary_inputs"], first["num_annotated"]) == (4, 1, 2, 1)
    assert await _refreshed(ds, monkeypatch) == first

    _row(ds, "0005", {"input.bin": "b", "output-1.txt": "1", "output-2.txt": "2"})   # put / append / promote
    assert await _refreshed(ds, monkeypatch) == _reindex(ds)
    assert _reindex(ds)["num_multi_output"] == 2

    shutil.rmtree(rows_root_of(ds) / "rows" / "0002")                                                # delete
    after = _reindex(ds)
    assert await _refreshed(ds, monkeypatch) == after
    assert (after["num_rows"], after["num_binary_inputs"]) == (4, 2)


def test_the_index_and_the_parsed_rows_give_the_same_facts(tmp_path):
    ds = _seed(tmp_path)
    index = dataset_layout_for(DataLayoutEnum.IO_FOLDER).index(rows_root_of(ds), dataset_id="d")
    assert derive_counts(index) == _reindex(ds)


# ── FlowMessage: the typed sender names the author ──

def test_an_agent_message_is_shown_as_the_agent_not_the_person():
    fm = FlowMessage(
        text="hi",
        sender_id="user-uuid",
        sender_name="Alice Human",
        sender=MessageSender.agent("agent-1"),
    )
    assert fm.sender.kind.value == "agent"
    assert fm.author_label == "agent:agent-1"
    assert "Alice Human" not in fm.summary()


def test_a_user_message_still_shows_its_name():
    fm = FlowMessage(text="hi", sender_id="u1", sender_name="Alice")
    assert fm.author_label == "Alice"
