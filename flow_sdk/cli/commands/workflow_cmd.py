"""Workflow CLI surface.

``flow workflow report --data '<WorkflowReportEntry json>' [--process <id>]``

Appends one trace event to ``<output_folder>/workflow.trace.jsonl`` of the
target ``AgenticProcess``. The flow skill drives this from inside a
``claude -p`` worker; ``--process`` defaults to ``FLOWPAD_EXECUTION_SCOPE``.

``flow workflow`` is reserved for future siblings (``run``, ``list``,
``validate``); ``report`` takes a typed JSON payload so future trace kinds
(``condition``, ``call``, ``return``) are schema additions, not new
sub-verbs.
"""

from __future__ import annotations

import json
from typing import Annotated, Optional

import typer

from flow_sdk.cli.commands._common import (
    fail as _fail,
    ok as _ok,
    resolve_process_id as _resolve_process_id,
)

workflow_app = typer.Typer(
    name="workflow",
    help="Workflow operations.",
    add_completion=False,
    no_args_is_help=True,
)

EXIT_OK = 0
EXIT_INVALID_ARG = 2
EXIT_NOT_FOUND = 4


@workflow_app.command(
    "report",
    help="Append one trace event (WorkflowReportEntry JSON) to workflow.trace.jsonl.",
)
def workflow_report(
    data: Annotated[
        str,
        typer.Option("--data", "-d", help="JSON payload matching the WorkflowReportEntry schema."),
    ],
    process: Annotated[
        Optional[str],
        typer.Option(
            "--process", "-p", help="AgenticProcess id. Defaults to FLOWPAD_EXECUTION_SCOPE."
        ),
    ] = None,
) -> None:
    from flow_sdk.builtin.workflow import WorkflowReportEntry

    try:
        entry = WorkflowReportEntry.model_validate_json(data)
    except Exception as e:
        _fail(EXIT_INVALID_ARG, "INVALID_DATA", f"--data did not match WorkflowReportEntry: {e}")
        return

    process_id = _resolve_process_id(process)

    from flow_sdk.fs_store.fs_record import record_stem
    from flow_sdk.fs_store.record_paths import get_default_records_root

    record_dir = get_default_records_root() / "agentic_process" / record_stem("agentic_process", process_id)
    if not record_dir.exists():
        _fail(
            EXIT_NOT_FOUND,
            "PROCESS_NOT_FOUND",
            f"AgenticProcess {process_id} has no record_dir at {record_dir}",
        )
        return

    out_path = record_dir / "execution" / "output" / "workflow.trace.jsonl"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("a") as fh:
        fh.write(entry.model_dump_json() + "\n")
    _ok({"path": str(out_path), "entry": json.loads(entry.model_dump_json())})
