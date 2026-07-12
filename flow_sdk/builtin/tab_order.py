"""Pure tab-ordering algebra — the single source of truth for tab order.

These functions operate on a **global** ordered list of tab ids (ascending
``tab_order``). They are intentionally side-effect-free so they can be unit
tested against the shared front/back parity matrix
(``ui/tests/fixtures/tab-order-matrix.json``) — the frontend port lives in
``ui/src/tabs/tab-order.ts`` and MUST stay byte-for-byte equivalent.

Order grammar (docs/tab-management.md):
- A drag yields a drop-gap described by two anchors ``after_id`` / ``before_id``;
  either may be ``None`` (drop at the very start/end).
- ``new_tab`` reuses the same insertion: a tab opened from within a tab lands
  immediately after its opener; with no opener it appends.
- A project view is the global order filtered to ``{project == pid OR project is
  None}`` — projectless tabs (settings/search/diff) are inline, never a separate
  section.

``tab_order`` itself is just the contiguous index into the global list; the only
rows that need writing after a mutation are the ones whose index changed
(:func:`changed_ids`).
"""

from __future__ import annotations


def compute_reorder(
    order: list[str], reorder_id: str, after_id: str | None, before_id: str | None
) -> list[str]:
    """Move ``reorder_id`` into the drop-gap (after ``after_id`` / before
    ``before_id``) within the global ``order``. Anchors that are ``None`` or
    absent fall through to append-at-end."""
    ids = [i for i in order if i != reorder_id]
    if after_id is not None and after_id in ids:
        idx = ids.index(after_id) + 1
    elif before_id is not None and before_id in ids:
        idx = ids.index(before_id)
    else:
        idx = len(ids)
    ids.insert(idx, reorder_id)
    return ids


def compute_insert_new(order: list[str], new_id: str, after_id: str | None) -> list[str]:
    """Place a brand-new ``new_id`` immediately after ``after_id`` (the opener);
    append when there is no opener (or it is absent)."""
    if new_id in order:
        return list(order)  # reopen of an existing tab keeps its slot
    if after_id is not None and after_id in order:
        idx = order.index(after_id) + 1
        return order[:idx] + [new_id] + order[idx:]
    return [*order, new_id]


def compute_close(order: list[str], close_id: str) -> list[str]:
    """Drop ``close_id``; the survivors keep their relative order."""
    return [i for i in order if i != close_id]


def changed_ids(old_order: list[str], new_order: list[str]) -> set[str]:
    """Ids whose contiguous index changed between ``old_order`` and ``new_order``
    — exactly the ``tab_order`` rows that must be persisted. Empty ⇒ no write."""
    old_idx = {tid: i for i, tid in enumerate(old_order)}
    return {tid for i, tid in enumerate(new_order) if old_idx.get(tid) != i}


def filter_for_project(
    order: list[str], project_of: dict[str, str | None], project_id: str | None
) -> list[str]:
    """The scope view: global order filtered to tabs whose project EXACTLY matches
    ``project_id`` (a project id, or ``None`` for the Global/no-active-project
    scope), preserving global order. A tab belongs to exactly one scope — a
    projectless tab (``project is None``) appears only in the ``None`` view, never
    inside a project's strip."""
    return [tid for tid in order if project_of.get(tid) == project_id]
