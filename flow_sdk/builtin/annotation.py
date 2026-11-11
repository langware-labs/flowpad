from typing import Any, Dict, Optional

from pydantic import model_validator

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity


#: Legacy ``labels`` marker -> subkind, in the order a list is read: a quick prompt
#: carried BOTH ``note:`` and ``quick-prompt:``, so the narrower marker is asked first.
_LEGACY_LABELS = {"quick-prompt:": "quick_prompt", "note:": "note", "comment:": "comment",
                  "prompt:": "prompt", "plan:": "plan", "lock_break": "lock_break"}
SUBKINDS = tuple(_LEGACY_LABELS.values())


def subkind_of_labels(labels: Any) -> str:
    """The subkind a legacy ``labels`` list names, or ``""``."""
    labels = labels or ()
    return next((subkind for label, subkind in _LEGACY_LABELS.items() if label in labels), "")


class Annotation(Entity):
    type: str = APIField(default="annotation")
    #: What this annotation IS — one of ``SUBKINDS``. A closed variant inside the type
    #: (docs/ontology.md), not a tag: it selects how the annotation is read and drawn.
    subkind: str = APIField("")
    target_type: str = APIField("")
    target_id: str = APIField("")
    content: str = APIField("")
    session_id: str = APIField("")   # Claude session ID
    iso_timestamp: str = APIField("")
    data: Optional[Dict[str, Any]] = APIField(default_factory=dict)  # PTY: seq, seqOffset, line

    @model_validator(mode="before")
    @classmethod
    def _subkind_from_labels(cls, data: Any) -> Any:
        """An annotation written before ``subkind`` (an old row, a peer on an older version)
        said what it is with ``labels`` markers; read them once, here."""
        if isinstance(data, dict) and "labels" in data:
            data = dict(data)
            subkind = subkind_of_labels(data.pop("labels"))
            if subkind and not data.get("subkind"):
                data["subkind"] = subkind
        return data

    @property
    def display_name(self) -> str:
        if self.content:
            first_line = str(self.content).strip().splitlines()[0][:100]
            if first_line:
                return first_line
        return self.name or ""
