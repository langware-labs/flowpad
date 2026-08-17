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
