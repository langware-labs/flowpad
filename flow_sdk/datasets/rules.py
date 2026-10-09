"""Rules across rows: what a record schema declares in ``rules`` (``DataSchemaRule``) and Flowpad
checks on every write and read of the rows -- so every writer keeps them, not only the app that
happens to know them.

A rule ``{"same": ["persona.icp", "icp"]}`` walks both paths from the row along its link fields
(``*`` = every element of a list) and requires every end reached on one side to be the row reached
on the other. A step that is empty (an unset optional link) means the rule does not apply.

A path step reads the linked ROW's value: ``links.find_row`` finds it beside the row's dataset, and
it is read as stored. ``override={ref: value}`` answers as if that row held ``value`` -- how a write
to a parent is checked against the rows below it before anything is written.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Optional

from flow_sdk.datasets.links import find_row


def rules_of(value_or_kind: Any) -> tuple:
    """The rules (``DataSchemaRule``) a value's schema -- or a schema class -- declares."""
    cls = value_or_kind if isinstance(value_or_kind, type) else type(value_or_kind)
    return getattr(cls, "__rules__", None) or ()


def _field(value: Any, name: str) -> Any:
    return value.get(name) if isinstance(value, dict) else getattr(value, name, None)


class _Rows:
    """Linked rows by reference, read once per check (``cache``), ``override`` first."""

    def __init__(self, owner: Path | str, override: Optional[dict], cache: Optional[dict]) -> None:
        self.owner, self.override = owner, override or {}
        self.cache = cache if cache is not None else {}
        self.datasets: dict[Path, Any] = {}

    def value(self, ref: str) -> Any:
        if ref in self.override:
            return self.override[ref]
        key = ("rule-row", ref)
        if key not in self.cache:
            self.cache[key] = self._read(ref)
        return self.cache[key]

    def _read(self, ref: str) -> Any:
        from flow_sdk.builtin.dataset import Dataset  # noqa: PLC0415

        found = find_row(ref, self.owner, cache=self.cache)
        if found is None:
            return None
        folder, key = found
        if folder not in self.datasets:
            self.datasets[folder] = Dataset.at(folder)
        try:
            row = self.datasets[folder].example(key)
        except Exception:  # noqa: BLE001 -- a row that does not read answers nothing; it is reported on its own
            return None
        return (row or {}).get("input")


def _ends(value: Any, steps: list[str], rows: _Rows) -> Optional[list]:
    """The references a path reaches from ``value`` -- None when a step on the way is empty."""
    current = [value]
    for i, step in enumerate(steps):
        last = i == len(steps) - 1
        reached = []
        for held in current:
            if step == "*":
                reached.extend(held or [])
                continue
            got = _field(held, step)
            if got in (None, "", []):
                return None
            reached.append(got)
        if not reached:
            return None
        if not last and steps[i + 1] != "*":
            # the next step reads a linked row's field: a reference is followed to the row's value
            reached = [rows.value(r) if isinstance(r, str) else r for r in reached]
            if any(v is None for v in reached):
                return None   # a row that is gone or does not read: the link check reports it
        current = reached
    return current


def rule_breaks(value: Any, owner: Path | str, *, override: Optional[dict] = None,
                cache: Optional[dict] = None, path: str = "") -> list[dict]:
    """``[{path, code: "rule", rule: {same, description}, message}]`` for each rule of ``value``'s
    schema it breaks -- ``rule`` names both ends, so a caller never has to work them out."""
    rows, out = _Rows(owner, override, cache), []
    for rule in rules_of(value):
        left, right = rule.same
        a, b = _ends(value, left.split("."), rows), _ends(value, right.split("."), rows)
        if a is None or b is None:
            continue
        if any(x != y for x in a for y in b):
            why = f" ({rule.description})" if rule.description else ""
            out.append({"path": f"{path}{left}", "code": "rule", "rule": rule.model_dump(mode="json"),
                        "message": f"rule: {left} must be the same row as {right}{why}"})
    return out


__all__ = ["rule_breaks", "rules_of"]
