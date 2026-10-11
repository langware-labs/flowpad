"""Diagnosing: what a diagnose declares, what it is called with, what it answers.

A diagnose is an asset -- ``agentic-assets/diagnose/<name>/`` with ``diagnose.json`` (a
``DiagnoseSpec``) and ``diagnose.py``, which defines ``async def diagnose(ctx) -> DiagnosisSpec``.
A project that ships one is diagnosed by it; any other is diagnosed by the shipped ``flowpad``
one. The runner (``flow_sdk.diagnose``) calls it with a ``FlowContextSpec`` and always answers a
``DiagnosisSpec`` -- a diagnose that fails or hangs still yields the baseline, marked ``partial``.
"""

from __future__ import annotations

from enum import StrEnum
from typing import ClassVar, Optional

from pydantic import Field

from flow_sdk.schema.data_spec.spec import DataSpec

DIAGNOSE_FILE = "diagnose.json"


class DiagnosePurpose(StrEnum):
    #: Describe what is wrong, change nothing (asking someone for help).
    REPORT = "report"
    #: Describe it, then repair what can safely be repaired (the Diagnose button, ``flow diagnose``).
    REPAIR = "repair"


class DiagnosisStatus(StrEnum):
    OK = "ok"  # nothing wrong
    INFORMATIONAL = "informational"  # nothing to act on
    NEEDS_ACTION = "needs_action"  # something is wrong and the person must act
    FIXED = "fixed"  # something was wrong and was repaired
    UNRECOGNIZED = "unrecognized"  # something is wrong and no known cause matches
    #: The diagnose itself failed, hung or answered nonsense: what is here is the baseline.
    PARTIAL = "partial"


class DiagnoseSpec(DataSpec):
    """``diagnose.json`` -- a diagnose: which module to call and how long it may take."""

    spec_kind: ClassVar[str] = "diagnose"

    name: str
    title: str = ""
    description: str = ""
    #: The module beside ``diagnose.json`` that defines ``diagnose(ctx)``.
    entry: str = "diagnose.py"
    #: How long ``diagnose(ctx)`` may run before the baseline is answered instead. It runs in the
    #: background, so the default is generous.
    timeout_s: float = Field(default=300, gt=0)


class FlowContextSpec(DataSpec):
    """Where the person is when a diagnosis is asked for -- what ``diagnose(ctx)`` is called with."""

    spec_kind: ClassVar[str] = "flow.context"

    purpose: DiagnosePurpose = DiagnosePurpose.REPORT
    #: The project the person is in (its local id), when there is one.
    project_id: Optional[str] = None
    #: The project's folder on this machine -- where its own diagnose would live.
    project_path: Optional[str] = None
    #: The agentic process on screen (a TypeId), when there is one.
    process: Optional[str] = None
    #: What the person said is wrong (free text or a pasted error); empty means "look at everything".
    user_report: str = ""
    #: Where it was asked from (``vibe``, ``footer``, ``cli``, ...).
    origin: str = ""
    #: The Flowpad instance (``FLOW_INSTANCE``) diagnosed.
    instance: str = ""


class DiagnosisFinding(DataSpec):
    """One thing the diagnose noticed."""

    spec_kind: ClassVar[str] = "diagnosis.finding"

    #: A stable id for the check (``hub.unreachable``, a catalog id such as ``A3``).
    id: str
    severity: str = "info"  # info | warning | error
    title: str
    detail: str = ""
    #: What it saw: a log line, a status code, a path.
    evidence: str = ""


class DiagnosisEnvironment(DataSpec):
    """The machine, as of the moment it was diagnosed -- it travels with the diagnosis, so a helper
    reads the asker's machine, not their own."""

    spec_kind: ClassVar[str] = "diagnosis.environment"

    reported_by: str = ""
    occurred_at: str = ""
    os: str = ""
    app_version: str = ""
    python: str = ""
    instance: str = ""
    backend_port: Optional[int] = None
    hub_url: str = ""


class LogTail(DataSpec):
    """The last lines of one log file, secrets redacted."""

    spec_kind: ClassVar[str] = "diagnosis.log_tail"

    file: str
    lines: list[str] = Field(default_factory=list)


class DiagnosisSpec(DataSpec):
    """A diagnosis -- what a diagnose answers, what is sent to a helper, what a viewer shows."""

    spec_kind: ClassVar[str] = "diagnosis"

    status: DiagnosisStatus = DiagnosisStatus.INFORMATIONAL
    title: str = ""
    summary: str = ""
    symptoms: str = ""
    rca: str = ""
    fix: str = ""
    findings: list[DiagnosisFinding] = Field(default_factory=list)
    environment: DiagnosisEnvironment = Field(default_factory=DiagnosisEnvironment)
    logs: list[LogTail] = Field(default_factory=list)
    #: The context it was asked in.
    context: Optional[FlowContextSpec] = None
    #: Which diagnose answered (``flowpad``, a project's own), empty when none could run.
    diagnose: str = ""
    #: What went wrong while diagnosing -- a diagnose that raised, hung or answered nonsense.
    errors: list[str] = Field(default_factory=list)
    started_at: str = ""
    elapsed_ms: int = 0
