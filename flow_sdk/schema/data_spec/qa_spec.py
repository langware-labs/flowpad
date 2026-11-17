"""The QA entity documents (builtin/qa.py): ``<type>.json`` per row, the record each row is rebuilt from.

Each is an entity document: it carries the row's id in its own root and EVERY field of the row, so the document
alone rebuilds the row after the index is cleared. A child names its parent (``parent_type_id``) and nests in the
parent's own folder: an iteration in its cycle, an execution in its iteration, a test case in its test file.
"""

from __future__ import annotations

from typing import ClassVar, Optional

from flow_sdk.schema.data_spec.frontmatter import AssetDocumentSpec


class _QADocument(AssetDocumentSpec):
    #: An entity document: it carries its own id in its root, the way ``compute_op.json`` does.
    manifest_layout: ClassVar[str | None] = "entity"

    #: The row's name AND its folder name.
    name: Optional[str] = None


class _QAChildDocument(_QADocument):
    #: The row it nests in, as a typeid.
    parent_type_id: Optional[str] = None


class QAPhaseSpec(_QADocument):
    main_file: ClassVar[str | None] = "qa_phase.json"

    step: int = 0
    repo: str = ""
    created_at: Optional[str] = None


class QATestFileSpec(_QADocument):
    main_file: ClassVar[str | None] = "qa_test_file.json"

    repo: str = ""
    phase: str = ""
    path: str = ""
    runner: Optional[str] = None
    test_count: Optional[int] = None
    commit_sha: Optional[str] = None
    blob_sha: Optional[str] = None
    removed: bool = False
    assigned_by: str = "mapper"
    created_at: Optional[str] = None


class QATestCaseSpec(_QAChildDocument):
    main_file: ClassVar[str | None] = "qa_test_case.json"

    phase: str = ""
    test_file: str = ""
    commit_sha: Optional[str] = None
    removed: bool = False
    assigned_by: str = "mapper"
    created_at: Optional[str] = None


class QACycleSpec(_QADocument):
    main_file: ClassVar[str | None] = "qa_cycle.json"

    cycle_id: str = ""
    status: str = "running"
    repo: str = ""
    branch: str = ""
    commit_sha: str = ""
    started_by: Optional[str] = None
    started_at: Optional[str] = None
    ended_at: Optional[str] = None
    stop_reason: Optional[str] = None
    notes: Optional[str] = None


class QAIterationSpec(_QAChildDocument):
    main_file: ClassVar[str | None] = "qa_iteration.json"

    iteration_id: str = ""
    cycle: str = ""
    order: int = 0
    status: str = "running"
    commit_sha: Optional[str] = None
    cost_usd: Optional[float] = None
    started_at: Optional[str] = None
    ended_at: Optional[str] = None
    notes: Optional[str] = None
    planned: dict[str, list[str]] = {}
    purpose: Optional[str] = None
    request: Optional[str] = None


class QATestExecutionSpec(_QAChildDocument):
    main_file: ClassVar[str | None] = "qa_test_execution.json"

    cycle: str = ""
    iteration: str = ""
    phase: str = ""
    test_file: str = ""
    test_case: Optional[str] = None
    test_name: str = ""
    test_number: Optional[int] = None
    attempt: int = 1
    status: str = ""
    started_at: Optional[str] = None
    ended_at: Optional[str] = None
    duration_s: Optional[float] = None
    error: Optional[str] = None
    error_category: Optional[str] = None
    process_id: Optional[str] = None
    attachments: list[str] = []
    rca: Optional[str] = None
