"""Unit tests for PromptQueue — pure file manipulation, no worker, no DB."""
import json

import pytest

from flow_sdk.builtin.agentic_process.prompt_queue import PromptQueue
from flow_sdk.fs_store.fs_ref import FSRef


def _queue(tmp_path) -> PromptQueue:
    # nested dir on purpose — PromptQueue must create parents.
    return PromptQueue(FSRef(str(tmp_path / "rec" / "prompt_queue.json")))


@pytest.mark.timeout(5)
def test_default_when_missing(tmp_path):
    q = _queue(tmp_path)
    assert q.read() == {"enabled": True, "entries": []}
    assert q.entries == []
    assert q.enabled is True
    assert q.is_empty is True
    assert q.peek() is None
    assert q.pop() is None


@pytest.mark.timeout(5)
def test_enqueue_is_fifo(tmp_path):
    q = _queue(tmp_path)
    a = q.enqueue("first")
    b = q.enqueue("second")
    assert [e["prompt"] for e in q.entries] == ["first", "second"]
    assert q.peek()["id"] == a["id"]
    assert q.pop()["id"] == a["id"]  # head first
    assert q.pop()["id"] == b["id"]
    assert q.is_empty


@pytest.mark.timeout(5)
def test_persistence_across_instances(tmp_path):
    path = str(tmp_path / "rec" / "prompt_queue.json")
    PromptQueue(FSRef(path)).enqueue("x", source="trigger")
    again = PromptQueue(FSRef(path))
    assert [e["prompt"] for e in again.entries] == ["x"]
    assert again.entries[0]["source"] == "trigger"


@pytest.mark.timeout(5)
def test_dequeue_by_id_and_index(tmp_path):
    q = _queue(tmp_path)
    q.enqueue("a")
    b = q.enqueue("b")
    q.enqueue("c")
    assert q.dequeue(b["id"]) is True
    assert [e["prompt"] for e in q.entries] == ["a", "c"]
    assert q.dequeue(0) is True
    assert [e["prompt"] for e in q.entries] == ["c"]
    assert q.dequeue("nope") is False
    assert q.dequeue(99) is False


@pytest.mark.timeout(5)
def test_clear_and_set_enabled(tmp_path):
    q = _queue(tmp_path)
    q.enqueue("a")
    q.enqueue("b")
    q.clear()
    assert q.is_empty
    q.set_enabled(False)
    assert q.enabled is False
    q.set_enabled(True)
    assert q.enabled is True


@pytest.mark.timeout(5)
def test_corrupt_file_returns_default_and_recovers(tmp_path):
    path = tmp_path / "rec" / "prompt_queue.json"
    path.parent.mkdir(parents=True)
    path.write_text("{ this is not valid json", encoding="utf-8")
    q = PromptQueue(FSRef(str(path)))
    assert q.read() == {"enabled": True, "entries": []}  # no raise
    q.enqueue("ok")  # overwrites the corrupt file
    assert [e["prompt"] for e in q.entries] == ["ok"]


@pytest.mark.timeout(5)
def test_log_records_each_action(tmp_path):
    q = _queue(tmp_path)
    q.enqueue("a", source="ui")
    q.pop(source="drain")
    q.log("drain_check", "ready", reason="ok")
    logged = q.log_entries()
    pairs = [(line["action"], line["source"]) for line in logged]
    assert ("enqueue", "ui") in pairs
    assert ("pop", "drain") in pairs
    assert ("drain_check", "ready") in pairs
    assert all("ts" in line for line in logged)


@pytest.mark.timeout(5)
def test_atomic_write_leaves_valid_json_no_tmp(tmp_path):
    q = _queue(tmp_path)
    q.enqueue("a")
    rec_dir = tmp_path / "rec"
    json.loads((rec_dir / "prompt_queue.json").read_text(encoding="utf-8"))  # parses
    assert list(rec_dir.glob("*.tmp*")) == []  # no temp leftovers
