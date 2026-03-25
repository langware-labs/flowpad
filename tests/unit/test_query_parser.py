"""Tests for Query parser.

Migrated from flowpad/hub/tests/unit/test_query_parser.py.

Skipped tests:
- test_complex_data_match_query (already skipped in old repo, needs Neo4j driver)
"""

import pytest
from starlette.datastructures import QueryParams

from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp
from flow_sdk.utils import starlett_query_brackets_to_dict


def test_valid_simple_query():
    json_str = {"match": {"op": "$EQ", "operands": ["fieldName", "value"]}}
    query = QueryFilter.model_validate(json_str)
    assert query.match is not None
    assert query.match.op == QueryOp.EQ
    assert query.match.operands == ["fieldName", "value"]


def test_shortened_query():
    q = QueryFilter.parse('{"a":1}', "user")
    assert q.match is not None
    assert q.match.op == QueryOp.EQ
    assert len(q.match.operands) == 2
    assert q.match.operands[0] == "a"
    assert q.match.operands[1] == 1


def test_shortened_query_multiple():
    q = QueryFilter.parse('{"a":1, "b":2}', "user")
    assert q.match is not None
    assert q.match.op == QueryOp.AND
    assert len(q.match.operands) == 2
    exp1 = q.match.operands[0]
    assert isinstance(exp1, ExpressionNode)
    assert len(exp1.operands) == 2
    assert exp1.operands[0] == "a"
    assert exp1.operands[1] == 1
    exp2 = q.match.operands[1]
    assert isinstance(exp2, ExpressionNode)
    assert len(exp2.operands) == 2
    assert exp2.operands[0] == "b"
    assert exp2.operands[1] == 2


def test_parse_url_query():
    url_query = "type=func&match[op]=$EQ&match[operands][0]=title&match[operands][1]=Func+Title"
    qp = dict(QueryParams(url_query))
    assert qp == {
        "match[op]": "$EQ",
        "match[operands][0]": "title",
        "match[operands][1]": "Func Title",
        "type": "func",
    }
    assert starlett_query_brackets_to_dict(qp) == {
        "type": "func",
        "match": {"op": "$EQ", "operands": ["title", "Func Title"]},
    }


if __name__ == "__main__":
    pytest.main()
