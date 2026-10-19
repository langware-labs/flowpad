"""Keeping a field in step with a copy OUTSIDE Flowpad (a CRM field, a sheet cell): the three-way rule.

A sync remembers, per field, the value both sides last agreed on. Then, for each field:

* both sides hold the same value                    -> ``"same"``  (the agreement moves to it)
* only Flowpad's side changed since the agreement   -> ``"here"``  (write it out)
* only the outside changed since                    -> ``"there"`` (take it in)
* BOTH changed since and they differ                -> ``"hold"``  (write neither; report it)

Never last-writer-wins: that silently drops the other side's edit. With no agreement on record yet
(a first run, a lost state file), a side that is empty takes the other's value, and two different
values are held -- there is no telling which is newer.

Every clone may run the same sync, each with its own memory of the agreement, so "the outside
changed" includes "another machine wrote it": holding instead of overwriting is what keeps one
machine from undoing another's edit.
"""

from __future__ import annotations

from typing import Any, Literal

Decision = Literal["same", "here", "there", "hold"]
_UNSET = object()


def _empty(value: Any) -> bool:
    return value is None or value == "" or value == [] or value == {}


def _same(a: Any, b: Any) -> bool:
    return (_empty(a) and _empty(b)) or a == b


def three_way(here: Any, there: Any, agreed: Any = _UNSET) -> tuple[Decision, Any]:
    """``(decision, value)`` for one field: ``here`` is Flowpad's value, ``there`` the outside's,
    ``agreed`` the value both last agreed on (leave it out when none is on record). ``value`` is
    what both sides should hold after the decision -- for ``"hold"``, Flowpad's, left as it is."""
    if _same(here, there):
        return "same", here
    if agreed is _UNSET:
        if _empty(here):
            return "there", there
        if _empty(there):
            return "here", here
        return "hold", here
    if _same(here, agreed):
        return "there", there
    if _same(there, agreed):
        return "here", here
    return "hold", here


__all__ = ["Decision", "three_way"]
