"""Recent log lines of this Flowpad, secrets redacted -- a value any message or report can carry.

A diagnosis holds them as evidence (``DiagnosisSpec.logs``); a help request carries them as a value of their own
(``LogsSpec``), so they show as a chip ("Logs") and the person can leave them out.
"""

from __future__ import annotations

from typing import ClassVar

from pydantic import Field

from flow_sdk.schema.data_spec.spec import DataSpec


class LogTail(DataSpec):
    """The last lines of one log file, secrets redacted."""

    spec_kind: ClassVar[str] = "diagnosis.log_tail"

    file: str
    lines: list[str] = Field(default_factory=list)


class LogsSpec(DataSpec):
    """This computer's recent logs: one tail per log file."""

    spec_kind: ClassVar[str] = "logs"

    files: list[LogTail] = Field(default_factory=list)
