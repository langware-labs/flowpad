"""Tests for RecordList.children_of and RecordList.root (submodule 7)."""

from __future__ import annotations

from unittest.mock import MagicMock, PropertyMock, patch

from flow_sdk.fs_store.record_list import RecordList
from flow_sdk.fs_store.record_query import RecordQuery


def _make_child(uid: str, name: str, type_: str = "note") -> MagicMock:
    child = MagicMock()
    child.id = uid
    child.name = name
    child.type = type_
    child.status = None
    child.created_at = None
    child.modified_at = None
    child.parent_ref = None
    return child


def _make_parent(children: list, typed_children: dict | None = None):
    parent = MagicMock()
    type(parent).children = PropertyMock(return_value=children)

    def get_children_by_type(t: str):
        if typed_children:
            return typed_children.get(t, [])
        return [c for c in children if c.type == t]

    parent.get_children_by_type = get_children_by_type
    return parent


class TestChildrenOf:
    def test_children_of_yields_children(self):
        c1, c2, c3 = _make_child("a", "A"), _make_child("b", "B"), _make_child("c", "C")
        parent = _make_parent([c1, c2, c3])

        rl = RecordList.children_of(parent)
        result = list(rl)

        assert len(result) == 3
        assert result == [c1, c2, c3]

    def test_children_of_with_type_filter(self):
        c1 = _make_child("a", "A", "note")
        c2 = _make_child("b", "B", "task")
        c3 = _make_child("c", "C", "note")
        parent = _make_parent([c1, c2, c3])

        rl = RecordList.children_of(parent, child_type="note")
        result = list(rl)

        assert len(result) == 2
        assert all(r.type == "note" for r in result)

    def test_children_of_query_compose(self):
        c1 = _make_child("a", "Alpha")
        c2 = _make_child("b", "Beta")
        c3 = _make_child("c", "Charlie")
        parent = _make_parent([c1, c2, c3])

        rl = RecordList.children_of(parent)
        q = RecordQuery(sort_by="name", sort_desc=False, limit=2)
        result = rl.query(q)

        assert len(result) == 2
        assert result[0].name == "Alpha"
        assert result[1].name == "Beta"


class TestRoot:
    @patch("flow_sdk.fs_store.record_list.RecordList.__init__", return_value=None)
    def test_root_equivalent_to_constructor(self, mock_init):
        mock_cls = MagicMock()
        rl = RecordList.root(mock_cls)
        mock_init.assert_called_once_with(record_class=mock_cls)
