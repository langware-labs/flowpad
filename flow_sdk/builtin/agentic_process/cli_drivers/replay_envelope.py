"""The shared FlowData envelope for transcript entries.

Wrapping a parsed transcript entry into a ``FlowData`` — derive its refinements,
attach a ``ProcessEntry``, and stamp the four envelope attributes — is the same
work for every vendor. Only ONE piece of it is vendor knowledge: which
``FlowElementType`` a given entry *kind* maps to. That is passed in.

Why a parameter rather than a shared table
------------------------------------------
The six copies of ``_element_type_for_kind`` across the four vendor packages are
**not** the same function, and unifying them would change what the UI renders:

* claude and codex test ``kind in _TOOL_USE_KINDS`` — so ``shell_command``,
  ``file_write``, ``search``, ``web_fetch``, ``agent_spawn`` … render as
  **TOOL_CALL**.
* copilot and opencode test ``kind == "tool_use"`` only — so those same kinds
  render as **STATUS**.
* Even within claude the two copies disagree: ``session_history.py`` carries a
  12-member set (including ``flow_command`` and ``skill_call``) while
  ``event_to_flowdata.py`` carries 10 — so a ``skill_call`` renders differently
  on claude's replay path than on its live path.

Whether a copilot file-write *should* be a tool-call chip is a product decision
about chip rendering, not a refactor decision. Passing the mapping keeps every
vendor's current behaviour exactly while putting the divergence in one place
where it can be settled deliberately.

Claude is deliberately NOT a caller of :func:`wrap_live`: its own ``_wrap_live``
never calls ``derive_entry``, always builds a fresh ``FlowData`` rather than
reusing ``entry.to_flow_data()``, and stamps two attributes instead of four.
Routing it through here would change every live claude frame.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowData, FlowDataType
from flow_sdk.transcript_analyzer import AgentTranscriptFile
from flow_sdk.transcript_analyzer.derive import derive_entry
from flow_sdk.transcript_analyzer.process_entry import ProcessEntry

#: ``(entry_kind_value) -> FlowElementType``. Vendor-owned; see the module note.
ElementTypeForKind = Callable[[str], str]

#: ``(entry, transcript_format) -> frames | None``. A vendor hook consulted
#: before the standard envelope: return frames to REPLACE this entry's, or None
#: to fall through. Copilot uses it to expand its own ``flowpad.*`` terminal
#: events, which are FlowPad-authored envelopes rather than vendor entries.
EntryFrames = Callable[[Any, Any], "list[FlowData] | None"]


def _envelope(entry, element_type_for_kind: ElementTypeForKind, kind: str) -> dict:
    """The four attributes every vendor stamps, live or replay.

    Spelled once so a typo in one of the four former copies cannot make a
    replayed frame disagree with the live frame for the same entry.
    """
    return {
        "element-type": element_type_for_kind(entry.kind.value),
        "data-type": FlowDataType.OBJECT,
        "subtype": entry.kind.value,
        "observation-kind": kind,
    }


def wrap_live(entry, element_type_for_kind: ElementTypeForKind) -> FlowData:
    """Wrap a parsed entry as a LIVE ``FlowData`` frame.

    Derived refinements (e.g. a ``flow`` CLI call inside a shell command) are
    applied here so the live frame matches what history's refold produces for
    the same entry.

    Attributes are stamped with ``setdefault`` so a converter that already made
    a more specific choice keeps it.
    """
    entry = derive_entry(entry)
    process_entry = ProcessEntry(transcript_entry=entry, observation_kind="live").to_dict()
    envelope = _envelope(entry, element_type_for_kind, "live")
    frames = entry.to_flow_data()
    if frames:
        frame = frames[0]
        frame.process_entry = process_entry
        for key, value in envelope.items():
            frame.attributes.setdefault(key, value)
        return frame

    return FlowData(
        flow_value={},
        created_time=entry.timestamp or "",
        attributes=dict(envelope),
        process_entry=process_entry,
    )


def entry_to_replay_flow_data(
    entry,
    element_type_for_kind: ElementTypeForKind,
) -> list[FlowData]:
    """Wrap a parsed entry in the same envelope the live stream stamps.

    Mirrors :func:`wrap_live` field for field, differing only in
    ``observation_kind`` — so a reloaded session is row-for-row comparable with
    what a live subscriber saw.

    Without this a replayed frame carried no ``ProcessEntry``, no ``subtype``
    and no ``observation-kind``, so every chip the UI builds off the typed entry
    (a ``flow`` CLI call, a file write, a skill) silently degraded to a nameless
    generic row after a page refresh.

    Codex is deliberately NOT a caller: its replay path additionally refines the
    subtype for SYSTEM entries, *assigns* rather than ``setdefault``s, and
    stamps ``turn-terminated``, ``phase``, ``transcript-entry-id`` and
    ``transcript-source-entry-id``. Six behaviour deltas — folding it in would
    mean deciding which of them the other vendors should acquire.
    """
    process_entry = ProcessEntry(transcript_entry=entry, observation_kind="replay").to_dict()
    envelope = _envelope(entry, element_type_for_kind, "replay")
    frames = entry.to_flow_data()
    if not frames:
        # Entries whose ``to_flow_data()`` is deliberately empty still get one
        # frame — ``wrap_live`` does the same, so the two paths stay aligned.
        return [
            FlowData(
                flow_value={},
                created_time=entry.timestamp or "",
                attributes=dict(envelope),
                process_entry=process_entry,
            )
        ]

    # `envelope` is loop-invariant and `setdefault` evaluates its default
    # eagerly, so building it once keeps the vendor mapping off the frame path.
    is_virtual = getattr(entry, "virtual", False)
    for frame in frames:
        frame.process_entry = process_entry
        for key, value in envelope.items():
            frame.attributes.setdefault(key, value)
        if is_virtual:
            frame.attributes["is-virtual"] = "true"
    return frames


def load_transcript_history(
    worker: str,
    transcript: Path,
    element_type_for_kind: ElementTypeForKind,
    *,
    logger,
    transcript_format=None,
    entry_frames: EntryFrames | None = None,
) -> list[FlowData]:
    """Parse a transcript file and replay every entry through the envelope.

    A parse failure returns ``[]`` — the caller shows an empty history rather
    than an error row. Codex deliberately does the opposite (WARNING plus a
    synthesised ERROR frame), which is why it is not a caller here.
    """
    try:
        parsed = AgentTranscriptFile(worker, transcript, transcript_format=transcript_format)
    except Exception:
        logger.debug("%s history parse failed for %s", worker, transcript, exc_info=True)
        return []
    history: list[FlowData] = []
    for entry in parsed.entries:
        if entry_frames is not None:
            override = entry_frames(entry, parsed.transcript_format)
            if override is not None:
                history.extend(override)
                continue
        history.extend(entry_to_replay_flow_data(entry, element_type_for_kind))
    return history
