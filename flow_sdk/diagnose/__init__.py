"""Diagnosing Flowpad -- one runner for every caller (ask-for-help, the Diagnose button, ``flow diagnose``).

A diagnose is an asset (``agentic-assets/diagnose/<name>/diagnose.json`` + ``diagnose.py``); see
``flow_sdk.schema.data_spec.diagnose_spec`` for the shapes and ``runner`` for how one is chosen and run.
"""

from flow_sdk.diagnose.runner import DiagnoseError, progress, resolve_diagnose, resolve_shipped, run_diagnose
from flow_sdk.schema.data_spec.diagnose_spec import (
    DiagnosePurpose,
    DiagnoseSpec,
    DiagnosisEnvironment,
    DiagnosisFinding,
    DiagnosisSpec,
    DiagnosisStatus,
    FlowContextSpec,
    LogTail,
)

__all__ = [
    "DiagnoseError",
    "DiagnosePurpose",
    "DiagnoseSpec",
    "DiagnosisEnvironment",
    "DiagnosisFinding",
    "DiagnosisSpec",
    "DiagnosisStatus",
    "FlowContextSpec",
    "LogTail",
    "progress",
    "resolve_diagnose",
    "resolve_shipped",
    "run_diagnose",
]
