"""Asking a dataset for SOME of its rows: match, order, page, count.

The expression is the one entity queries already speak (``flow_sdk.db.drivers.query``:
``ExpressionNode`` / ``QueryFilter``) -- there it compiles to SQL; rows live in folders, so here it
is evaluated in memory against a row as the API hands it out (``Dataset._row_out``: ``key``, ``id``,
``ref``, ``version``, ``kind``, and the slots). This is the Python twin of the TypeScript
``QueryFilter.validate`` (``ts_sdk/src/FlowSync/query.ts``); the two are held together by one shared
table of cases (``test_fixtures/dataset_query_cases.json``), run by both test suites.

A field is a path: ``key``, or dotted into a slot -- ``input.day``, ``input.stage_dates.won``. A
date is compared as it travels, an ISO string (``"2026-09-01" <= "2026-09-30"``). A path that leads
nowhere is null: it matches ``$IS_NULL``, and no comparison.
"""

from __future__ import annotations

from typing import Any, Callable, Iterable, Optional

from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp


def field_of(row: Any, path: Any) -> Any:
    """The value at ``path`` in ``row``: the key as written when the row has it, else walked dot by
    dot (a list is stepped into by index). None when the path leads nowhere."""
    if not isinstance(path, str):
        return None
    if isinstance(row, dict) and path in row:
        return row[path]
    at = row
    for step in path.split("."):
        if isinstance(at, dict):
            at = at.get(step)
        elif isinstance(at, list) and step.isdigit() and int(step) < len(at):
            at = at[int(step)]
        else:
            return None
    return at


def _ordered(test: Callable[[Any, Any], bool]) -> Callable[[Any, Any], bool]:
    """A comparison that is False -- never an error -- across null or kinds that do not compare."""
    def compare(a: Any, b: Any) -> bool:
        if a is None or b is None:
            return False
        try:
            return bool(test(a, b))
        except TypeError:
            return False
    return compare


_COMPARE: dict[QueryOp, Callable[[Any, Any], bool]] = {
    QueryOp.EQ: lambda a, b: a == b,
    QueryOp.NE: lambda a, b: a != b,
    QueryOp.GT: _ordered(lambda a, b: a > b),
    QueryOp.GE: _ordered(lambda a, b: a >= b),
    QueryOp.LT: _ordered(lambda a, b: a < b),
    QueryOp.LE: _ordered(lambda a, b: a <= b),
    QueryOp.LIKE: lambda a, b: str("" if b is None else b).lower() in str("" if a is None else a).lower(),
}


def _prop(operand: Any) -> Optional[str]:
    """The field a ``{$PROP: [field]}`` operand names, else None."""
    if isinstance(operand, ExpressionNode) and operand.op == QueryOp.PROP and operand.operands:
        return operand.operands[0]  # type: ignore[return-value]
    return None


def matches(node: Optional[ExpressionNode], row: Any) -> bool:
    """Does ``row`` pass the expression? No expression passes everything."""
    if node is None:
        return True
    op, operands = node.op or QueryOp.EQ, node.operands
    if op == QueryOp.AND:
        return all(matches(operand, row) for operand in operands)  # type: ignore[arg-type]
    if op == QueryOp.OR:
        return any(matches(operand, row) for operand in operands)  # type: ignore[arg-type]
    if op == QueryOp.IS_NULL:
        return field_of(row, operands[0]) is None
    if op == QueryOp.IS_NOT_NULL:
        return field_of(row, operands[0]) is not None
    if len(operands) != 2:
        return False
    if op in (QueryOp.IN, QueryOp.NIN):
        if isinstance(operands[1], list):                 # [field, [values]]: the field is one of these
            hit = field_of(row, operands[0]) in operands[1]
        else:                                             # [value, {$PROP: field}]: the list field holds the value
            field = _prop(operands[1])
            held = field_of(row, field) if field else None
            if not isinstance(held, (list, str)):
                return False
            hit = operands[0] in held
        return hit if op == QueryOp.IN else not hit
    test = _COMPARE.get(op)
    if test is None:
        raise ValueError(f"unsupported operation: {op.value}")
    field = _prop(operands[1])
    if field is not None:                                 # [value, {$PROP: field}]
        return test(field_of(row, field), operands[0])
    return test(field_of(row, operands[0]), operands[1])


def expression(match: Any) -> Optional[ExpressionNode]:
    """``match`` as an expression: one already, a plain ``{field: value}`` map (all must hold), or
    ``{op, operands}``. None / empty matches everything. ``ValueError`` when it is none of these."""
    if match is None or match == {}:
        return None
    if isinstance(match, ExpressionNode):
        return match
    if not isinstance(match, dict):
        raise ValueError("match: an expression or a {field: value} map is required")
    return QueryFilter.parse({"match": match}).match


def _sort_key(value: Any) -> tuple:
    # nulls last in ascending order; mixed kinds never raise (grouped by kind name, then value)
    if value is None:
        return (2, "", "")
    if isinstance(value, bool):
        return (0, "bool", value)
    if isinstance(value, (int, float)):
        return (0, "number", value)
    return (0, type(value).__name__, value if isinstance(value, str) else str(value))


def order(rows: Iterable[Any], order_by: Any) -> list:
    """``rows`` sorted by ``order_by`` -- ``{path: "asc"|"desc"}``, or a list of those (first wins).
    Stable; a row without the field sorts last ascending, first descending."""
    out = list(rows)
    steps = [order_by] if isinstance(order_by, dict) else list(order_by or [])
    pairs = [(path, direction) for step in steps for path, direction in step.items()]
    for path, direction in reversed(pairs):
        if direction not in ("asc", "desc"):
            raise ValueError(f"order_by {path!r}: 'asc' or 'desc' is required, not {direction!r}")
        out.sort(key=lambda row, p=path: _sort_key(field_of(row, p)), reverse=direction == "desc")
    return out


def select(rows: Iterable[Any], *, match: Any = None, order_by: Any = None,
           limit: Optional[int] = None, offset: Optional[int] = None) -> tuple[list, int]:
    """``(the page, how many matched in all)``: match, then order, then ``offset`` / ``limit``."""
    node = expression(match)
    found = [row for row in rows if matches(node, row)]
    if order_by:
        found = order(found, order_by)
    start = max(0, int(offset or 0))
    stop = None if limit is None else start + max(0, int(limit))
    return found[start:stop], len(found)


def count(rows: Iterable[Any], *, match: Any = None, group_by: Optional[list[str]] = None) -> dict:
    """``{total, groups}``: how many rows match, and -- with ``group_by`` (field paths) -- how many
    per distinct combination of those fields, as ``[{by: {path: value}, count}]``, largest first
    (ties in the order first seen)."""
    node = expression(match)
    found = [row for row in rows if matches(node, row)]
    out: dict = {"total": len(found), "groups": []}
    if group_by:
        tally: dict[str, dict] = {}
        for row in found:
            by = {path: field_of(row, path) for path in group_by}
            slot = tally.setdefault(repr([by[path] for path in group_by]), {"by": by, "count": 0})
            slot["count"] += 1
        out["groups"] = sorted(tally.values(), key=lambda g: -g["count"])
    return out


__all__ = ["count", "expression", "field_of", "matches", "order", "select"]
