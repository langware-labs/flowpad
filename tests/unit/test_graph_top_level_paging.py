"""Unit tests for ``_apply_top_level_paging`` (graph list ?limit=/?offset=).

Historically only limit/offset INSIDE the filter JSON were honored; a
top-level ``?limit=5000`` was silently dropped — turning intended-bounded
list calls into full-corpus dumps (the 3.3MB markdown whale).
"""

from types import SimpleNamespace

from flow_sdk.app.actions.graph_crud_actions import _apply_top_level_paging
from flow_sdk.db.drivers.query import QueryFilter


def _info(**params):
    return SimpleNamespace(request_parameters=params)


def test_top_level_limit_and_offset_applied():
    qf = QueryFilter(type="markdown")
    _apply_top_level_paging(_info(limit="50", offset="10"), qf)
    assert qf.limit == 50
    assert qf.offset == 10


def test_filter_json_limit_wins():
    qf = QueryFilter.parse({"match": {}, "limit": 7}, "markdown")
    _apply_top_level_paging(_info(limit="5000"), qf)
    assert qf.limit == 7


def test_malformed_values_ignored():
    qf = QueryFilter(type="markdown")
    _apply_top_level_paging(_info(limit="lots", offset="-3"), qf)
    assert qf.limit is None
    assert qf.offset is None


def test_absent_params_noop():
    qf = QueryFilter(type="markdown")
    _apply_top_level_paging(_info(), qf)
    assert qf.limit is None
    assert qf.offset is None
