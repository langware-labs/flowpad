"""``flow artifact`` — a registered deliverable.

The second layer, and the reason derivation recurses: this refines a
``FlowCommandEntry`` that another handler produced, rather than re-reading the
shell command. Each layer stays one rule, and ``ArtifactEntry`` subclasses
``FlowCommandEntry`` so the chain is a genuine refinement rather than two
parallel readings of the same line.

Deriving also makes reload work for nothing. The artifact's minted id lives only
in the database — the vendor transcript holds just the address the agent typed —
so a server-synthesized frame would exist in the live stream and vanish on
refresh. Derivation runs on every refold, so the chip a reload rebuilds is the
chip the live session showed.
"""

from __future__ import annotations

from ...entries import ArtifactEntry, FlowCommandEntry
from ...entry import EntryKind, TranscriptEntry
from ..registry import ANY_WORKER, register
from ..virtual import shell_fields, virtual_envelope

ARTIFACT_VERB = "artifact"


def derive_artifact(entry: TranscriptEntry) -> list[TranscriptEntry] | None:
    if not isinstance(entry, FlowCommandEntry):
        return None
    if entry.verb != ARTIFACT_VERB:
        return None
    # Already the refinement — a re-derive must not chain onto itself. The
    # registry's visited set covers the same-list case; this covers a caller
    # passing an already-derived list from elsewhere.
    if isinstance(entry, ArtifactEntry):
        return None

    return [
        ArtifactEntry(
            verb=entry.verb,
            subverb=entry.subverb,
            target=entry.target,
            flow_args=entry.flow_args,
            **shell_fields(entry),
            **virtual_envelope(entry, "artifact"),
        )
    ]


def install() -> None:
    register(ANY_WORKER, EntryKind.FLOW_COMMAND, derive_artifact)
