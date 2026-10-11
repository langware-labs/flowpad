"""Asking a dataset for SOME of its rows: match, order, page, count.

The expression is the one entity queries already speak (``flow_sdk.db.drivers.query``:
``ExpressionNode`` / ``QueryFilter``) -- there it compiles to SQL; rows live in folders, so here it
is evaluated in memory against a row as the API hands it out (``Dataset._row_out``: ``key``, ``id``,
``ref``, ``version``, ``kind``, and the slots). This is the Python twin of the TypeScript
``QueryFilter.validate`` (``ts_sdk/src/FlowSync/query.ts``); the two are held together by one shared
table of cases (``test_fixtures/dataset_query_cases.json``), run by both test suites.

ONE PATH GRAMMAR, the one a schema's ``rules`` already write, with the slot spelled out:

* ``key``, ``input.day``, ``input.stage_dates.won`` -- dot by dot; a list by index (``input.steps.0``);
* ``input.tags.*`` -- every element of a list (``*``, as in a rule's ``messages.*.use_case``): the
  path then has SEVERAL values, and a test passes when ANY of them does;
* ``input.persona.icp`` -- a step that lands on a reference to a row (``<kind>.id.<uuid>``) with
  more path to go FOLLOWS the link and carries on in the linked row's ``input``; right after a link,
  ``key`` / ``id`` / ``ref`` name the linked row itself (``input.persona.key``). Followed only when
  the caller gives a way to read linked rows (``follow`` -- ``Dataset`` does), so a string that
  merely looks like a path is never chased.

A date is compared as it travels, an ISO string (``"2026-09-01" <= "2026-09-30"``). A path that
leads nowhere is null: it matches ``$IS_NULL``, and no comparison.
"""

from __future__ import annotations

import datetime as dt
from typing import Any, Callable, Iterable, Optional

from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp
from flow_sdk.schema.data_spec.value_ref import parse_ref

#: ``follow(reference) -> the linked row as the API hands it out ({key, id, ref, input, ...})``, or
#: None when it names no row. Given by whoever can read the datasets beside (``Dataset``).
Follow = Callable[[str], Optional[dict]]
#: What may follow a link to name the linked ROW rather than a field of its value.
ROW_NAMES = ("key", "id", "ref")


class Many(list):
    """Several values at one path (a ``*`` step): a test passes when any of them does."""


def _step(at: Any, step: str, follow: Optional[Follow]) -> Any:
    if isinstance(at, str) and follow is not None and parse_ref(at) is not None:
        linked = follow(at)                      # a link with more path to go: on into the linked row
        if linked is None:
            return None
        if step in ROW_NAMES:
            return linked.get(step)
        at = linked.get("input")
    if isinstance(at, dict):
        return at.get(step)
    if isinstance(at, list) and step.isdigit() and int(step) < len(at):
        return at[int(step)]
    return None


def field_of(row: Any, path: Any, follow: Optional[Follow] = None) -> Any:
    """The value at ``path`` in ``row`` (the module's path grammar): the key as written when the row
    has it, else walked step by step. None when the path leads nowhere; a ``Many`` when it crossed a
    ``*``. The TypeScript twin (``fieldOf``) walks the same way without following links -- a link is
    followed where the rows are, on the server."""
    if not isinstance(path, str):
        return None
    if isinstance(row, dict) and path in row:
        return row[path]
    current, many = [row], False
    for step in path.split("."):
        if step == "*":
            many = True
            current = [item for at in current if isinstance(at, list) for item in at]
        else:
            current = [_step(at, step, follow) for at in current]
        if not current:
            break
    if many:
        return Many(v for v in current if v is not None)
    return current[0] if current else None


def _values(value: Any) -> list:
    """The values a test is tried against: each of a ``Many``, else the one."""
    return list(value) if isinstance(value, Many) else [value]


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
    QueryOp.LIKE: lambda a, b: _like(a, b),
}


def _like(held: Any, wanted: Any) -> bool:
    """Case-insensitive substring -- of the value, or of ANY element when the field holds a list
    (never of the list's printed form)."""
    needle = str("" if wanted is None else wanted).lower()
    if isinstance(held, list):
        return any(_like(item, wanted) for item in held)
    return needle in str("" if held is None else held).lower()


def _prop(operand: Any) -> Optional[str]:
    """The field a ``{$PROP: [field]}`` operand names, else None."""
    if isinstance(operand, ExpressionNode) and operand.op == QueryOp.PROP and operand.operands:
        return operand.operands[0]  # type: ignore[return-value]
    return None


def matches(node: Optional[ExpressionNode], row: Any, follow: Optional[Follow] = None) -> bool:
    """Does ``row`` pass the expression? No expression passes everything."""
    if node is None:
        return True
    op, operands = node.op or QueryOp.EQ, node.operands
    if op == QueryOp.AND:
        return all(matches(operand, row, follow) for operand in operands)  # type: ignore[arg-type]
    if op == QueryOp.OR:
        return any(matches(operand, row, follow) for operand in operands)  # type: ignore[arg-type]
    if op == QueryOp.IS_NULL:
        return all(v is None for v in _values(field_of(row, operands[0], follow)))
    if op == QueryOp.IS_NOT_NULL:
        return any(v is not None for v in _values(field_of(row, operands[0], follow)))
    if len(operands) != 2:
        return False
    if op in (QueryOp.IN, QueryOp.NIN):
        if isinstance(operands[1], list):                 # [field, [values]]: the field is one of these
            hit = any(v in operands[1] for v in _values(field_of(row, operands[0], follow)))
        else:                                             # [value, {$PROP: field}]: the list field holds the value
            field = _prop(operands[1])
            held = field_of(row, field, follow) if field else None
            if not isinstance(held, (list, str)):
                return False
            hit = operands[0] in held
        return hit if op == QueryOp.IN else not hit
    test = _COMPARE.get(op)
    if test is None:
        raise ValueError(f"unsupported operation: {op.value}")
    field = _prop(operands[1])
    held, wanted = (field_of(row, field, follow), operands[0]) if field is not None else (field_of(row, operands[0], follow), operands[1])
    if isinstance(held, Many):
        if op == QueryOp.NE:                              # "is not X": none of the values is
            return all(test(v, wanted) for v in held)
        return any(test(v, wanted) for v in held)
    return test(held, wanted)


def texts_of(value: Any) -> Iterable[str]:
    """Every string a row holds, however deep (list items, nested values) -- what ``q`` reads."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for held in value.values():
            yield from texts_of(held)
    elif isinstance(value, list):
        for held in value:
            yield from texts_of(held)


def says(row: Any, q: Optional[str]) -> bool:
    """Does the row's text hold every word of ``q``, case-insensitive, each in some string of it?
    (``q`` is how record search spells its query; here it reads one row. No ``q`` passes everything.)"""
    words = (q or "").lower().split()
    if not words:
        return True
    text = "\n".join(texts_of(row)).lower()
    return all(word in text for word in words)


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


def _first(value: Any) -> Any:
    return (value[0] if value else None) if isinstance(value, Many) else value


def _pairs(order_by: Any) -> list[tuple[str, str]]:
    steps = [order_by] if isinstance(order_by, dict) else list(order_by or [])
    pairs = [(path, direction) for step in steps for path, direction in step.items()]
    for path, direction in pairs:
        if direction not in ("asc", "desc"):
            raise ValueError(f"order_by {path!r}: 'asc' or 'desc' is required, not {direction!r}")
    return pairs


def order(rows: Iterable[Any], order_by: Any, follow: Optional[Follow] = None,
          read: Optional[Callable[[Any, str], Any]] = None) -> list:
    """``rows`` sorted by ``order_by`` -- ``{path: "asc"|"desc"}``, or a list of those (first wins).
    Stable; a row without the field sorts last ascending, first descending. ``read(row, path)``
    replaces the path walk (how groups are ordered by what they are grouped by)."""
    out = list(rows)
    read = read or (lambda row, path: _first(field_of(row, path, follow)))
    for path, direction in reversed(_pairs(order_by)):
        out.sort(key=lambda row, p=path: _sort_key(read(row, p)), reverse=direction == "desc")
    return out


def select(rows: Iterable[Any], *, match: Any = None, order_by: Any = None, limit: Optional[int] = None,
           offset: Optional[int] = None, q: Optional[str] = None, follow: Optional[Follow] = None) -> tuple[list, int]:
    """``(the page, how many matched in all)``: ``match`` and ``q``, then order, then ``offset`` / ``limit``."""
    node = expression(match)
    found = [row for row in rows if matches(node, row, follow) and says(row, q)]
    if order_by:
        found = order(found, order_by, follow)
    start = max(0, int(offset or 0))
    stop = None if limit is None else start + max(0, int(limit))
    return found[start:stop], len(found)


# ── counting: groups, buckets, metrics ───────────────────────────────────────
#: ``word:path`` -- the grammar's one colon form (``enum:a|b``): a BUCKET in ``group_by``
#: (``week:input.day``), a METRIC in ``metrics`` (``distinct:input.email``).
BUCKETS = ("day", "week", "month", "quarter")
METRICS = ("distinct", "min", "max", "sum")
WEEK_STARTS = ("monday", "sunday")


def _worded(entry: Any, words: tuple, what: str) -> tuple[Optional[str], str]:
    """``("week", "input.day")`` for ``"week:input.day"``; ``(None, path)`` for a plain path."""
    if not isinstance(entry, str) or not entry:
        raise ValueError(f"{what}: a path is required, not {entry!r}")
    word, sep, path = entry.partition(":")
    if not sep:
        return None, entry
    if word not in words or not path:
        raise ValueError(f"{what} {entry!r}: one of {', '.join(w + ':<path>' for w in words)} is required")
    return word, path


def bucket_of(value: Any, unit: str, week_start: str = "monday") -> Optional[str]:
    """The period a calendar day falls in, as its key: ``day`` ``2026-09-13`` · ``week`` the week's
    FIRST day ``2026-09-13`` · ``month`` ``2026-09`` · ``quarter`` ``2026-Q3``. Read from the first
    ten characters as written (a ``date`` is a calendar day: no time zone is applied). None for a
    value that is no date."""
    try:
        day = dt.date.fromisoformat(str(value)[:10])
    except (TypeError, ValueError):
        return None
    if unit == "day":
        return day.isoformat()
    if unit == "week":
        back = day.weekday() if week_start == "monday" else (day.weekday() + 1) % 7
        return (day - dt.timedelta(days=back)).isoformat()
    if unit == "month":
        return f"{day:%Y-%m}"
    return f"{day.year}-Q{(day.month - 1) // 3 + 1}"


def _measure(op: str, values: list) -> Any:
    held = [v for v in values if v is not None]
    if op == "distinct":
        return len({v if isinstance(v, (str, int, float, bool)) else repr(v) for v in held})
    if op == "sum":
        return sum(v for v in held if isinstance(v, (int, float)) and not isinstance(v, bool))
    if not held:
        return None
    try:
        return min(held) if op == "min" else max(held)
    except TypeError:
        return None


def count(rows: Iterable[Any], *, match: Any = None, group_by: Optional[list[str]] = None,
          metrics: Optional[dict[str, str]] = None, order_by: Any = None, week_start: str = "monday",
          q: Optional[str] = None, follow: Optional[Follow] = None) -> dict:
    """``{total, groups}``: how many rows match (``match`` and ``q``, as ``select``), and -- with
    ``group_by`` -- how many per distinct combination, as ``[{by: {<entry as written>: value}, count}]``.

    A ``group_by`` entry is a path, or a BUCKET of a date ``<day|week|month|quarter>:<path>``
    (``bucket_of``; a week begins on ``week_start``). A path over a list (``input.tags.*``) counts the
    row once under each of its values. ``metrics`` names further measures ``{name:
    "<distinct|min|max|sum>:<path>"}``, answered overall (``metrics``) and per group
    (``groups[].metrics``) -- absent unless asked. Groups come largest first, ties by their ``by``
    values; ``order_by`` (over ``group_by`` entries, ``count`` or a metric's name) orders them instead."""
    if week_start not in WEEK_STARTS:
        raise ValueError(f"week_start: one of {', '.join(WEEK_STARTS)} is required, not {week_start!r}")
    node = expression(match)
    entries = [(entry, *_worded(entry, BUCKETS, "group_by")) for entry in (group_by or [])]
    asked = {name: _worded(spec, METRICS, f"metrics {name!r}") for name, spec in (metrics or {}).items()}
    for name, (op, _) in asked.items():
        if op is None:
            raise ValueError(f"metrics {name!r}: one of {', '.join(m + ':<path>' for m in METRICS)} is required")
    found = [row for row in rows if matches(node, row, follow) and says(row, q)]

    def measured(members: list) -> dict:
        return {name: _measure(op, [v for row in members for v in _values(field_of(row, path, follow))])
                for name, (op, path) in asked.items()}

    out: dict = {"total": len(found), "groups": []}
    if asked:
        out["metrics"] = measured(found)
    if entries:
        tally: dict[str, dict] = {}
        for row in found:
            combos: list[dict] = [{}]
            for entry, unit, path in entries:
                held = _values(field_of(row, path, follow)) or [None]
                held = [bucket_of(v, unit, week_start) if unit else v for v in held]
                distinct = {repr(v): v for v in held}.values()      # a value once per row, kept as it is
                combos = [{**combo, entry: v} for combo in combos for v in distinct]
            for by in combos:
                slot = tally.setdefault(repr(list(by.values())), {"by": by, "count": 0, "rows": []})
                slot["count"] += 1
                slot["rows"].append(row)
        groups = []
        for slot in tally.values():
            group = {"by": slot["by"], "count": slot["count"]}
            if asked:
                group["metrics"] = measured(slot["rows"])
            groups.append(group)
        groups.sort(key=lambda g: (-g["count"], [_sort_key(v) for v in g["by"].values()]))
        if order_by:
            def read(group: dict, name: str) -> Any:
                if name == "count":
                    return group["count"]
                return group["by"][name] if name in group["by"] else (group.get("metrics") or {}).get(name)
            known = {"count", *(e for e, _, _ in entries), *asked}
            unknown = [name for name, _ in _pairs(order_by) if name not in known]
            if unknown:
                raise ValueError(f"order_by {unknown[0]!r}: a group is ordered by a group_by entry, 'count' or a metric's name")
            groups = order(groups, order_by, read=read)
        out["groups"] = groups
    return out


__all__ = ["BUCKETS", "METRICS", "Follow", "Many", "bucket_of", "count", "expression", "field_of", "matches",
           "order", "says", "select", "texts_of"]
