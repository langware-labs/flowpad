"""Tests for boolean filter coercion in SQLite driver.

The TypeScript SDK sends boolean query parameters as strings (e.g. "true"/"false")
in URL query parameters. The SQLite driver's _evaluate_expression must coerce these
strings to booleans when comparing against boolean entity attributes, otherwise
queries like { visible: true } return 0 results even when entities have visible=True.

Bug: True == "true" is False in Python, so the EQ filter fails.
"""

import pytest

from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp
from flow_sdk.db.drivers.sqlite.sqlite_driver import SQLiteDBDriver


def make_driver() -> SQLiteDBDriver:
    """Create a SQLiteDBDriver instance without opening a DB connection."""
    return SQLiteDBDriver.__new__(SQLiteDBDriver)


class TestBoolFilterCoercion:
    """Test that boolean entity attributes match string filter values from URL params."""

    def test_eq_true_string_matches_bool_true(self):
        """Filter 'visible=true' (string) should match entity with visible=True (bool)."""
        driver = make_driver()
        expression = ExpressionNode(op=QueryOp.EQ, operands=["visible", "true"])
        attrs = {"visible": True}
        assert driver._evaluate_expression(expression, attrs), (
            "EQ filter with string 'true' should match boolean True entity attribute"
        )

    def test_eq_false_string_matches_bool_false(self):
        """Filter 'visible=false' (string) should match entity with visible=False (bool)."""
        driver = make_driver()
        expression = ExpressionNode(op=QueryOp.EQ, operands=["visible", "false"])
        attrs = {"visible": False}
        assert driver._evaluate_expression(expression, attrs), (
            "EQ filter with string 'false' should match boolean False entity attribute"
        )

    def test_eq_true_string_does_not_match_bool_false(self):
        """Filter 'visible=true' should NOT match entity with visible=False."""
        driver = make_driver()
        expression = ExpressionNode(op=QueryOp.EQ, operands=["visible", "true"])
        attrs = {"visible": False}
        assert not driver._evaluate_expression(expression, attrs), (
            "EQ filter with string 'true' should NOT match boolean False entity attribute"
        )

    def test_eq_bool_true_still_matches_bool_true(self):
        """Filter with literal True (bool) still matches entity with visible=True."""
        driver = make_driver()
        expression = ExpressionNode(op=QueryOp.EQ, operands=["visible", True])
        attrs = {"visible": True}
        assert driver._evaluate_expression(expression, attrs), (
            "EQ filter with boolean True should match boolean True entity attribute"
        )
