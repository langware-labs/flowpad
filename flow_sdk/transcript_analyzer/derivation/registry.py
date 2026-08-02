"""The derivation registry and its worklist — where meaning is added to shape.

A parser's job ends at *shape*: it turns a vendor line into the closest physical
entry it can (``ToolUseEntry``, ``ShellCommandEntry``, a message, a result).
Everything above that — "this tool call was a file write", "this shell command
was a ``flow`` CLI call", "that flow call registered an artifact" — is *meaning*,
and meaning is worker-agnostic. Deriving it here means one rule, tested once,
that every worker gets.

The alternative is what the codebase had: each semantic kind re-implemented in
each parser, so a kind existed only where someone remembered it. That is why
codex produced no ``FileReadEntry`` and copilot no ``ExitPlanModeEntry`` — not a
decision, just a gap nobody could see.

Three properties make this safe to run on a hot path:

* **Additive.** A generated entry is appended beside its source, never in place
  of it. The physical record of what the worker actually emitted stays intact
  and auditable; consumers that want only meaning filter on ``virtual``.
* **Recursive.** A generated entry is fed back into the worklist, so a handler
  can refine another handler's output and each layer stays one rule
  (shell → flow_command → artifact). Termination is enforced, not hoped for.
* **Idempotent.** ``parse_delta`` re-derives the whole retained list on every
  delta, so deriving twice must produce the same list. Handlers are pure and
  the visited set makes a second pass a no-op.
"""

from __future__ import annotations

import logging
from collections import deque
from typing import Callable, Iterable

from ..entry import EntryKind, TranscriptEntry

logger = logging.getLogger(__name__)

#: A handler sees one entry and returns the entries it generates, or None.
#: Returning None and returning [] mean the same thing; None reads better at
#: the call sites that are a single ``if`` away from doing nothing.
DerivationHandler = Callable[[TranscriptEntry], list[TranscriptEntry] | None]

#: Matches any worker. Most semantics are worker-agnostic — that is the whole
#: point — so this is the common case. The worker dimension exists for the
#: genuinely structural differences (codex's ``apply_patch`` decomposing one
#: call into N file ops), not for tool-name spelling, which belongs in a map.
ANY_WORKER = "*"

#: Depth cap for the recursive worklist. A chain deeper than this is a
#: registration bug — a handler generating something that feeds itself — and we
#: would rather log it and stop than build an unbounded list on a parse path.
#: Today's deepest real chain is 2 (shell → flow_command → artifact).
MAX_DERIVATION_DEPTH = 8

_HANDLERS: dict[tuple[str, EntryKind], list[DerivationHandler]] = {}


def register(worker: str, kind: EntryKind, handler: DerivationHandler) -> None:
    """Register ``handler`` for entries of ``kind`` produced by ``worker``.

    ``worker`` is a driver short-id (``claude`` / ``codex`` / ``copilot``) or
    :data:`ANY_WORKER`. Registration order is preserved and both the
    worker-specific and the any-worker handlers run — specific ones first, so a
    vendor rule can generate something an agnostic rule then refines.
    """
    _HANDLERS.setdefault((worker, kind), []).append(handler)


def _handlers_for(entry: TranscriptEntry) -> list[DerivationHandler]:
    specific = _HANDLERS.get((entry.worker, entry.kind), [])
    generic = _HANDLERS.get((ANY_WORKER, entry.kind), [])
    return [*specific, *generic]


def derive_entries(entries: Iterable[TranscriptEntry]) -> list[TranscriptEntry]:
    """Return ``entries`` with every derivable meaning appended in place.

    Output order is source-then-refinements: each generated entry lands
    immediately after the entry it came from, so a chain reads in layer order
    and a consumer rendering the list top-down never sees a refinement before
    its source.
    """
    entries = list(entries)
    # Re-deriving an already-derived list must add nothing — ``parse_delta``
    # re-runs this over the whole retained list on every delta. Generated ids
    # are deterministic (``{source.id}:{suffix}``), so "already present" is an
    # exact test rather than a heuristic, and it stays correct for a PARTIALLY
    # derived list: a chain whose leaf is missing still grows that leaf.
    known = {e.id for e in entries}

    out: list[TranscriptEntry] = []
    for entry in entries:
        out.append(entry)
        out.extend(_derive_from(entry, known))
    return out


def _derive_from(source: TranscriptEntry, known: set[str] | None = None) -> list[TranscriptEntry]:
    """Everything derivable from ``source``, transitively, in layer order.

    ``known`` carries ids already present in the caller's list; anything
    regenerating one of them is dropped rather than duplicated.
    """
    # Two guards, and they do different jobs. ``known`` gives idempotency ACROSS
    # calls: generated ids are deterministic, so re-deriving an already-derived
    # list regenerates ids that are already present and drops them. Termination
    # WITHIN a call is the depth cap alone — a handler minting a fresh suffix per
    # layer produces ids that are always new, so ``known`` would never fire.
    known = set() if known is None else known
    known.add(source.id)
    generated: list[TranscriptEntry] = []
    frontier = deque([(source, 0)])

    while frontier:
        entry, depth = frontier.popleft()
        if depth >= MAX_DERIVATION_DEPTH:
            logger.warning(
                "transcript derivation: depth cap %d reached at entry %s (kind=%s) — "
                "a handler is likely generating an entry that feeds itself",
                MAX_DERIVATION_DEPTH,
                entry.id,
                entry.kind.value,
            )
            continue

        for handler in _handlers_for(entry):
            try:
                produced = handler(entry)
            except Exception:
                # One bad handler must not cost the caller its transcript. A
                # missing chip is recoverable; an unparseable session is not.
                logger.exception(
                    "transcript derivation: handler failed on entry %s (kind=%s)",
                    entry.id,
                    entry.kind.value,
                )
                continue
            for child in produced or []:
                if child.id in known:
                    # Already in the caller's list — this is a re-derive. Do not
                    # append it, and do not walk into it: whatever it refines
                    # into is present for the same reason.
                    continue
                known.add(child.id)
                generated.append(child)
                frontier.append((child, depth + 1))

    return generated
