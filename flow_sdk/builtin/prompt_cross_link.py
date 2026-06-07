"""Shared prompt↔process cross-link helper (pin-from-history).

Pinning a conversation-history item creates a library ``Prompt`` and mutually
links the Prompt and its ``AgenticProcess`` into each other's PRIVATE context
entities — mirroring ``transcript_analyzer/plan_cross_link.py``. Idempotent:
``add/remove_private_context_entities`` dedup by ``(type, id)`` and ``save()``
only fires when something actually changed.
"""
from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from flow_sdk.builtin.agentic_process import AgenticProcess
    from flow_sdk.builtin.prompt import Prompt


async def cross_link_prompt_to_process(prompt: "Prompt", proc: "AgenticProcess") -> bool:
    """Mutually link ``prompt`` and ``proc`` via private context entities.

    The AP-side entry carries the prompt's asset path (when known) so a chip
    click that 404s (entity not yet indexed) can self-heal via
    single-file-index — same convention as the plan/file cross-links.

    Returns True when either side changed (and was saved).
    """
    from flow_sdk.fs_store.type_id import TypeId  # noqa: PLC0415

    changed_prompt = prompt.add_private_context_entities(
        TypeId(type=proc.get_type(), id=proc.id)
    )
    asset_ref = getattr(prompt, "asset_ref", None)
    changed_proc = proc.add_private_context_entities(
        TypeId(type=prompt.get_type(), id=prompt.id),
        data={"path": asset_ref} if asset_ref else None,
    )
    if changed_prompt:
        await prompt.save()
    if changed_proc:
        await proc.save()
    return changed_prompt or changed_proc


async def remove_prompt_process_link(prompt: "Prompt", proc: "AgenticProcess") -> bool:
    """Remove the mutual private-context link between ``prompt`` and ``proc``.

    Returns True when either side changed (and was saved).
    """
    from flow_sdk.fs_store.type_id import TypeId  # noqa: PLC0415

    changed_prompt = prompt.remove_private_context_entities(
        TypeId(type=proc.get_type(), id=proc.id)
    )
    changed_proc = proc.remove_private_context_entities(
        TypeId(type=prompt.get_type(), id=prompt.id)
    )
    if changed_prompt:
        await prompt.save()
    if changed_proc:
        await proc.save()
    return changed_prompt or changed_proc
