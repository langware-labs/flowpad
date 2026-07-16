"""Generic two-entity private-context cross-link.

The single primitive behind every "link entity A and entity B into each
other's context" flow (markdown↔process, plan↔process, prompt↔process, …).
Replaces the former per-type helpers (``file_cross_link`` / ``plan_cross_link``
/ ``prompt_cross_link``): a caller resolves its two entities, then calls this.

Both arguments must be the LIVE in-memory instances the caller keeps using —
``private_context_entities`` is last-writer-wins, so a later ``save()`` of a
stale copy of either side would overwrite the link.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Iterable

    from flow_sdk.core.entity.entity_model import Entity


async def cross_link_entities(
    a: "Entity",
    b: "Entity",
    *,
    a_data: dict | None = None,
    b_data: dict | None = None,
    save: bool = True,
) -> bool:
    """Mutually link ``a`` and ``b`` via their private context entities.

    Adds ``b`` to ``a``'s private context (with optional per-entry ``a_data``)
    and ``a`` to ``b``'s (with optional ``b_data``). Both adds dedup by
    ``(type, id)``, so repeat calls are no-ops. When ``save`` (the default),
    each side is persisted only if it actually changed. Returns ``True`` when
    either side changed.

    ``a``/``b`` data sidecars carry hints like ``{"path": ...}`` so a chip
    click that 404s (entity not yet indexed) can self-heal via single-file
    index — same convention the former per-type helpers used.
    """
    if a is None or b is None:
        return False
    changed_a = a.add_private_context_entities(b.typeid, data=a_data)
    changed_b = b.add_private_context_entities(a.typeid, data=b_data)
    if save:
        if changed_a:
            await a.save()
        if changed_b:
            await b.save()
    return changed_a or changed_b


async def cross_link_all(
    entities: "Iterable[Entity]",
    *,
    save: bool = True,
) -> int:
    """Mutually link EVERY entity in ``entities`` into every other's private
    context — the N-way generalization of ``cross_link_entities``.

    After the call each entity holds all the OTHERS in its
    ``private_context_entities`` (deduped by ``(type, id)``, so repeat calls are
    no-ops). This is the "a message's attachments all see each other" primitive:
    given the entities a message attached, each one's private context gains its
    siblings.

    Like ``cross_link_entities``, the arguments must be the LIVE in-memory
    instances (private context is last-writer-wins, so saving a stale copy would
    drop the link). Entities are deduped by ``typeid`` first, so passing the same
    entity twice never self-links it. When ``save`` (the default) each side is
    persisted only if it actually changed. Returns the number of entities whose
    stored context changed.
    """
    live: list["Entity"] = []
    seen: set[tuple[str, str]] = set()
    for e in entities:
        if e is None:
            continue
        key = (e.typeid.type, e.typeid.id)
        if key in seen:
            continue
        seen.add(key)
        live.append(e)
    if len(live) < 2:
        return 0
    changed = 0
    for e in live:
        others = [o.typeid for o in live if o is not e]
        if e.add_private_context_entities(*others):
            changed += 1
            if save:
                await e.save()
    return changed


async def uncross_link_entities(
    a: "Entity",
    b: "Entity",
    *,
    save: bool = True,
) -> bool:
    """Remove the mutual private-context link between ``a`` and ``b``.

    Returns ``True`` when either side changed (and was saved when ``save``)."""
    if a is None or b is None:
        return False
    changed_a = a.remove_private_context_entities(b.typeid)
    changed_b = b.remove_private_context_entities(a.typeid)
    if save:
        if changed_a:
            await a.save()
        if changed_b:
            await b.save()
    return changed_a or changed_b
