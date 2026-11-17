"""The QA entities: what is stored about testing a repository.

A repository's tests form a plan (``QAPhase`` → ``QATestFile`` → ``QATestCase``), run in cycles (``QACycle``), each a
series of passes (``QAIteration``), with every attempt at a test case recorded (``QATestExecution``). The root-cause
analysis of an execution that did not pass is the generic ``Rca`` (builtin/rca.py).

The rows are written and read through the generic graph API (``/api/v1/graph/<type>``).
**Identity is the natural key, looked up — not derived.** A row's id is an ordinary uuid4, minted on its first
create; a create sends no id. Each type declares its natural key once (``TypeInfo.natural_key``, indexed), and a
create for a key a row already holds answers with that row (``find_existing_for_create``), so a retried write lands
on it. A reference to another QA row is ``<name>_id`` and holds that row's id; a row that nests in another (an
iteration in its cycle, an execution in its iteration, a test case in its test file) names it by ``parent_type_id``
alone, and its document lands in that row's folder. Test-file and phase verdicts are not stored: they are
inferred from the test executions.
"""

from __future__ import annotations

from typing import ClassVar, Optional

from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.core import Entity
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.schema.types import EntityType


class QAEntity(Entity):
    """A QA row: a create for a natural key a stored row already holds answers with that row (the graph create
    route's hook)."""

    _abstract: ClassVar[bool] = True

    async def find_existing_for_create(self) -> "Entity | None":
        schema_self = SchemaRegistry.get(self.get_type())
        natural_keys = schema_self.natural_key if schema_self is not None else []

        key = {name: getattr(self, name) for name in natural_keys}
        if any(value in (None, "") for value in key.values()):
            return None
        return await type(self).get_one(key)


class QAPhase(QAEntity):
    """A phase of the plan: a group of test files run together (e.g. "pytest unit", "Playwright")."""

    type: str = APIField(default=EntityType.QA_PHASE.value)
    #: Its document's folder: ``<scope>/agentic-assets/<type>/<name>/``, the record the row is rebuilt from.
    asset_ref: Optional[str] = APIField(default=None, sharing=Sharing.PRIVATE)
    #: Its place in the repository's run order, from 1. ``name`` is the phase's title.
    step: int = APIField(default=0)
    #: The target repository, ``org/repo``.
    repo: str = APIField(default="")
    created_at: Optional[str] = APIField(default=None, description="When it was defined, ISO-8601 UTC")


class QATestFile(QAEntity):
    """A test file of the plan, in exactly one phase."""

    type: str = APIField(default=EntityType.QA_TEST_FILE.value)
    #: Its document's folder: ``<scope>/agentic-assets/<type>/<name>/``, the record the row is rebuilt from.
    asset_ref: Optional[str] = APIField(default=None, sharing=Sharing.PRIVATE)
    #: The target repository, ``org/repo``: a file is one row per repository, whatever its phase.
    repo: str = APIField(default="")
    #: The ``QAPhase`` it belongs to, by id.
    phase_id: str = APIField(default="")
    #: The file, from the repository root (normalized).
    path: str = APIField(default="")
    #: What runs it (pytest, vitest, playwright, …).
    runner: Optional[str] = APIField(default=None)
    #: How many test cases the mapper counted in it, when it knows.
    test_count: Optional[int] = APIField(default=None)
    #: The commit it was mapped at.
    commit_sha: Optional[str] = APIField(default=None)
    #: Its git blob id (the hash of its content) at ``commit_sha``. The same blob id at another commit: the file is unchanged
    #: there and its mapping holds; a different one: it changed since it was mapped.
    blob_sha: Optional[str] = APIField(default=None)
    #: True once the file is gone from the repository: it stays, with its executions, and is no longer planned.
    removed: bool = APIField(default=False)
    #: ``"mapper"`` | ``"tester"``: who put it in its phase.
    assigned_by: str = APIField(default="mapper")
    created_at: Optional[str] = APIField(default=None, description="When it was defined, ISO-8601 UTC")


class QATestCase(QAEntity):
    """A test case of the plan. ``name`` is the test case as its runner names it; ``parent_type_id`` is the
    ``QATestFile`` it is in."""

    type: str = APIField(default=EntityType.QA_TEST_CASE.value)
    #: Its document's folder: ``<scope>/agentic-assets/<type>/<name>/``, the record the row is rebuilt from.
    asset_ref: Optional[str] = APIField(default=None, sharing=Sharing.PRIVATE)
    #: The ``QAPhase`` it belongs to (its test file's), by id.
    phase_id: str = APIField(default="")
    #: The commit it was registered at. Whether it changed since is its test file's ``blob_sha``.
    commit_sha: Optional[str] = APIField(default=None)
    #: True once the test case is gone from the repository: it stays, with its executions, and is no longer planned.
    removed: bool = APIField(default=False)
    #: ``"mapper"`` | ``"tester"``: who registered it.
    assigned_by: str = APIField(default="mapper")
    created_at: Optional[str] = APIField(default=None, description="When it was registered, ISO-8601 UTC")


class QACycle(QAEntity):
    """One QA cycle: the plan run on a repository's branch, in iterations. ``name`` says what it is."""

    type: str = APIField(default=EntityType.QA_CYCLE.value)
    #: Its document's folder: ``<scope>/agentic-assets/<type>/<name>/``, the record the row is rebuilt from.
    asset_ref: Optional[str] = APIField(default=None, sharing=Sharing.PRIVATE)
    #: ``qa-YYYYMMDD-HHMMSS``, its start time.
    label: str = APIField(default="")
    #: ``running`` | ``passed`` | ``failed`` | ``stopped`` | ``cancelled``.
    status: str = APIField(default="running")
    #: The repository under test, ``org/repo``.
    repo: str = APIField(default="")
    branch: str = APIField(default="")
    #: The commit the cycle started on; each iteration records the commit it tested.
    commit_sha: str = APIField(default="")
    started_by: Optional[str] = APIField(default=None)
    started_at: Optional[str] = APIField(default=None, description="ISO-8601 UTC")
    ended_at: Optional[str] = APIField(default=None, description="ISO-8601 UTC")
    stop_reason: Optional[str] = APIField(default=None)
    notes: Optional[str] = APIField(default=None)


class QAIteration(QAEntity):
    """One pass over the plan within a cycle; fixes land between iterations. ``parent_type_id`` is its ``QACycle``."""

    type: str = APIField(default=EntityType.QA_ITERATION.value)
    #: Its document's folder: ``<scope>/agentic-assets/<type>/<name>/``, the record the row is rebuilt from.
    asset_ref: Optional[str] = APIField(default=None, sharing=Sharing.PRIVATE)
    #: ``i01``, ``i02``, … in run order.
    label: str = APIField(default="")
    #: Its place in the cycle's run order, from 1.
    order: int = APIField(default=0)
    #: ``running`` | ``PASS`` | ``RED`` | ``BLOCKED`` | ``stopped``.
    status: str = APIField(default="running")
    #: The commit this iteration tested.
    commit_sha: Optional[str] = APIField(default=None)
    #: What it cost, in USD; the cycle's cost is the sum of its iterations'.
    cost_usd: Optional[float] = APIField(default=None)
    started_at: Optional[str] = APIField(default=None, description="ISO-8601 UTC")
    ended_at: Optional[str] = APIField(default=None, description="ISO-8601 UTC")
    #: The notes of whoever closed it, on what it did.
    notes: Optional[str] = APIField(default=None)
    #: What it is planned to run, by id: ``{"phases": [...], "test_files": [...], "test_cases": [...]}``.
    planned: dict[str, list[str]] = APIField(default_factory=dict)
    #: ``"fix"``: its tester fixes the failing tests it runs. None: it only runs them.
    purpose: Optional[str] = APIField(default=None)
    #: The request (a person's ask to run the plan) it was opened for, by id.
    request_id: Optional[str] = APIField(default=None)


class QATestExecution(QAEntity):
    """One attempt at one test case in an iteration: the one record test-file and phase verdicts are inferred from.
    ``parent_type_id`` is its ``QAIteration``."""

    type: str = APIField(default=EntityType.QA_TEST_EXECUTION.value)
    #: Its document's folder: ``<scope>/agentic-assets/<type>/<name>/``, the record the row is rebuilt from.
    asset_ref: Optional[str] = APIField(default=None, sharing=Sharing.PRIVATE)
    #: The ``QACycle``, ``QAPhase`` and ``QATestFile`` it belongs to, by id.
    cycle_id: str = APIField(default="")
    phase_id: str = APIField(default="")
    test_file_id: str = APIField(default="")
    #: The ``QATestCase`` it is an attempt at, by id; None for a test case the plan does not hold.
    test_case_id: Optional[str] = APIField(default=None)
    #: The test case as the run reported it (pytest node name, vitest title, e2e block title).
    test_name: str = APIField(default="")
    #: The test case's number in its file, as the QA skill numbers test blocks.
    test_number: Optional[int] = APIField(default=None)
    #: 1 for the first try, 2 and up for re-runs.
    attempt: int = APIField(default=1)
    #: ``pass`` | ``fail`` | ``skip`` | ``error`` | ``test-issue``.
    status: str = APIField(default="")
    started_at: Optional[str] = APIField(default=None, description="ISO-8601 UTC")
    ended_at: Optional[str] = APIField(default=None, description="ISO-8601 UTC")
    duration_s: Optional[float] = APIField(default=None)
    #: The failure message, when it did not pass.
    error: Optional[str] = APIField(default=None)
    #: Why it did not pass: ``product_bug`` | ``missing_credentials`` | ``env_bound`` | ``stale_test`` | ``flaky`` |
    #: ``requires_triage`` | ``unclassified``.
    error_category: Optional[str] = APIField(default=None)
    #: The agentic process that ran it.
    process_id: Optional[str] = APIField(default=None)
    #: Its attachments (screenshots, traces, logs), by ``File`` id.
    attachment_ids: list[str] = APIField(default_factory=list)
    #: The ``Rca`` that explains why it did not pass, by id; one analysis may explain several executions.
    rca_id: Optional[str] = APIField(default=None)

