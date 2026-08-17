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
from typing import Callable

from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowData, FlowDataType
from flow_sdk.transcript_analyzer.derive import derive_entry
from flow_sdk.transcript_analyzer.process_entry import ProcessEntry

#: ``(entry_kind_value) -> FlowElementType``. Vendor-owned; see the module note.
ElementTypeForKind = Callable[[str], str]


def wrap_live(entry, element_type_for_kind: ElementTypeForKind) -> FlowData:
    """Wrap a parsed entry as a LIVE ``FlowData`` frame.

    Derived refinements (e.g. a ``flow`` CLI call inside a shell command) are
    applied here so the live frame matches what history's refold produces for
    the same entry.

    Attributes are stamped with ``setdefault`` so a converter that already made
    a more specific choice keeps it.
    """
    entry = derive_entry(entry)
    process_entry = ProcessEntry(transcript_entry=entry, observation_kind="live")
    frames = entry.to_flow_data()
    if frames:
        frame = frames[0]
        frame.process_entry = process_entry.to_dict()
        frame.attributes.setdefault("element-type", element_type_for_kind(entry.kind.value))
        frame.attributes.setdefault("data-type", FlowDataType.OBJECT)
        frame.attributes.setdefault("subtype", entry.kind.value)
        frame.attributes.setdefault("observation-kind", "live")
        return frame

    return FlowData(
        flow_value={},
        created_time=entry.timestamp or "",
        attributes={
            "element-type": element_type_for_kind(entry.kind.value),
            "data-type": FlowDataType.OBJECT,
            "subtype": entry.kind.value,
            "observation-kind": "live",
        },
        process_entry=process_entry.to_dict(),
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
    frames = entry.to_flow_data()
    if not frames:
        # Entries whose ``to_flow_data()`` is deliberately empty still get one
        # frame — ``wrap_live`` does the same, so the two paths stay aligned.
        return [
            FlowData(
                flow_value={},
                created_time=entry.timestamp or "",
                attributes={
                    "element-type": element_type_for_kind(entry.kind.value),
                    "data-type": FlowDataType.OBJECT,
                    "subtype": entry.kind.value,
                    "observation-kind": "replay",
                },
                process_entry=process_entry,
            )
        ]

    for frame in frames:
        frame.process_entry = process_entry
        frame.attributes.setdefault("element-type", element_type_for_kind(entry.kind.value))
        frame.attributes.setdefault("data-type", FlowDataType.OBJECT)
        frame.attributes.setdefault("subtype", entry.kind.value)
        frame.attributes.setdefault("observation-kind", "replay")
        if getattr(entry, "virtual", False):
            frame.attributes["is-virtual"] = "true"
    return frames


def load_transcript_history(
    worker: str,
    transcript: Path,
    element_type_for_kind: ElementTypeForKind,
    *,
    transcript_format=None,
    logger=None,
) -> list[FlowData]:
    """Parse a transcript file and replay every entry through the envelope.

    A parse failure returns ``[]`` — the caller shows an empty history rather
    than an error row. Codex deliberately does the opposite (WARNING plus a
    synthesised ERROR frame), which is why it is not a caller here.
    """
    from flow_sdk.transcript_analyzer import AgentTranscriptFile  # noqa: PLC0415

    try:
        parsed = AgentTranscriptFile(worker, transcript, transcript_format=transcript_format)
    except Exception:
        if logger is not None:
            logger.debug("%s history parse failed for %s", worker, transcript, exc_info=True)
        return []
    history: list[FlowData] = []
    for entry in parsed.entries:
        history.extend(entry_to_replay_flow_data(entry, element_type_for_kind))
    return history
