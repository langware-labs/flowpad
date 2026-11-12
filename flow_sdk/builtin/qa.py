"""The QA entities: what Q (the QA app) stores about testing a repository.

Q maps a target repository's tests into a plan (``QAPhase`` → ``QATestFile`` → ``QATest``), runs that plan in
cycles (``QACycle``), each a series of passes (``QAIteration``), records every attempt at a test
(``QATestResult``) and the root-cause analysis of a result that did not pass (``QARca``).

Q writes and reads these rows from its own process through the generic graph API (``/api/v1/graph/<type>``).
Each row's id is Q's natural key, made a fixed uuid by ``allocate_id``, so a retried write lands on the same
row. A reference to another QA row holds that row's id. Phase, test file and phase-run results are not
stored: Q infers them from the test results.
"""

from __future__ import annotations

from typing import Optional

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.schema.types import EntityType


class QAPhase(Entity):
    """A phase of the plan: a group of test files run together (e.g. "pytest unit", "Playwright")."""

    type: str = APIField(default=EntityType.QA_PHASE.value)
    #: Its place in the repository's run order, from 1. ``name`` is the phase's title.
    step: int = APIField(default=0)
    #: The target repository, ``org/repo``.
    repo: str = APIField(default="")
    created_at: Optional[str] = APIField(default=None, description="When it was defined, ISO-8601 UTC")


class QATestFile(Entity):
    """A test file of the plan, in exactly one phase."""

    type: str = APIField(default=EntityType.QA_TEST_FILE.value)
    #: The ``QAPhase`` it belongs to (its id).
    phase: str = APIField(default="")
    #: The file, from the repository root (normalized).
    path: str = APIField(default="")
    #: What runs it (pytest, vitest, playwright, …).
    runner: Optional[str] = APIField(default=None)
    #: How many tests the mapper counted in it, when it knows.
    test_count: Optional[int] = APIField(default=None)
    #: True once the file is gone from the repository: it stays, with its results, and is no longer planned.
    removed: bool = APIField(default=False)
    #: ``"mapper"`` | ``"tester"``: who put it in its phase.
    assigned_by: str = APIField(default="mapper")
    created_at: Optional[str] = APIField(default=None, description="When it was defined, ISO-8601 UTC")


class QATest(Entity):
    """A test of the plan, in one test file. ``name`` is the test as its runner names it."""

    type: str = APIField(default=EntityType.QA_TEST.value)
    #: The ``QAPhase`` it belongs to (its test file's), by id.
    phase: str = APIField(default="")
    #: The ``QATestFile`` it is in, by id.
    test_file: str = APIField(default="")
    #: True once the test is gone from the repository: it stays, with its results, and is no longer planned.
    removed: bool = APIField(default=False)
    #: ``"mapper"`` | ``"tester"``: who registered it.
    assigned_by: str = APIField(default="mapper")
    created_at: Optional[str] = APIField(default=None, description="When it was registered, ISO-8601 UTC")


class QACycle(Entity):
    """One QA cycle: the plan run on a repository's branch, in iterations. ``name`` says what it is."""

    type: str = APIField(default=EntityType.QA_CYCLE.value)
    #: ``qa-YYYYMMDD-HHMMSS``, its start time.
    cycle_id: str = APIField(default="")
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


class QAIteration(Entity):
    """One pass over the plan within a cycle; fixes land between iterations."""

    type: str = APIField(default=EntityType.QA_ITERATION.value)
    #: ``i01``, ``i02``, … in run order.
    iteration_id: str = APIField(default="")
    #: The ``QACycle`` it belongs to, by id.
    cycle: str = APIField(default="")
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
    #: What it is planned to run, by id: ``{"phases": [...], "test_files": [...], "tests": [...]}``.
    planned: dict[str, list[str]] = APIField(default_factory=dict)
    #: ``"fix"``: its tester fixes the failing tests it runs. None: it only runs them.
    purpose: Optional[str] = APIField(default=None)
    #: The Run (a person's request in the Q app) it was opened for.
    request: Optional[str] = APIField(default=None)


class QATestResult(Entity):
    """One attempt at one test in an iteration: the one record test-file and phase results are inferred from."""

    type: str = APIField(default=EntityType.QA_TEST_RESULT.value)
    #: The ``QACycle``, ``QAIteration``, ``QAPhase`` and ``QATestFile`` it belongs to, by id.
    cycle: str = APIField(default="")
    iteration: str = APIField(default="")
    phase: str = APIField(default="")
    test_file: str = APIField(default="")
    #: The ``QATest`` it is an attempt at, by id; None for a test the plan does not hold.
    test: Optional[str] = APIField(default=None)
    #: The test as the run reported it (pytest node name, vitest title, e2e block title).
    test_name: str = APIField(default="")
    #: The test's number in its file, as the QA skill numbers test blocks.
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
    #: Its attachments (screenshots, traces, logs): ``File`` typeids.
    attachments: list[str] = APIField(default_factory=list)


class QARca(Entity):
    """The root-cause analysis of a test result that did not pass (a skip too: why it was skipped). One per result."""

    type: str = APIField(default=EntityType.QA_RCA.value)
    #: ``rca-<hash of its test result>``.
    rca_id: str = APIField(default="")
    #: The ``QATestResult`` it analyses, by id.
    test_result: str = APIField(default="")
    #: How hard the fix is: ``low`` | ``moderate`` | ``high``.
    complexity: str = APIField(default="")
    #: How bad the failure is if it stays: ``low`` | ``moderate`` | ``high``.
    severity: str = APIField(default="")
    #: The analysis, in markdown.
    description_md: str = APIField(default="")
    #: How to fix it, in a few words (at most 250 characters).
    suggested_fix_md: Optional[str] = APIField(default=None)
