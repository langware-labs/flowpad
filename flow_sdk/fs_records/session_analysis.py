"""SessionAnalysis -- stores analysis results for Claude sessions."""

from __future__ import annotations

import json
from typing import Any, ClassVar

from flow_sdk.fs_store import Record, RecordType


class SessionAnalysis(Record):
    """Analysis record for a Claude session.

    Lives in a FOLDER-layout directory with companion files
    (``analysis.json``, ``analysis.md``) alongside ``.flow_record/record.json``.
    """

    _record_type: ClassVar[str] = RecordType.SESSION_ANALYSIS
    index_fields: ClassVar[list[str]] = ["summary"]

    def __init__(self, **kwargs: Any):
        kwargs.setdefault("type", RecordType.SESSION_ANALYSIS)
        super().__init__(**kwargs)

    @property
    def search_content(self) -> str | None:
        parts: list[str] = []
        if self.name:
            parts.append(self.name)
        md = self.analysis_md
        if md:
            parts.append(md)
        return "\n".join(parts) if parts else None

    @property
    def analysis_json(self) -> dict:
        """Parsed contents of ``analysis.json``, or empty dict if missing."""
        content = self.read_file("analysis.json")
        if content is None:
            return {}
        return json.loads(content)

    @property
    def analysis_md(self) -> str:
        """Contents of ``analysis.md``, or empty string if missing."""
        return self.read_file("analysis.md") or ""
