"""The QA entities (builtin/qa.py) and the generic Rca (builtin/rca.py): registered as types, saved and queried like any entity."""
import pytest

from flow_sdk.builtin.qa import QACycle, QAIteration, QAPhase, QATest, QATestFile, QATestResult
from flow_sdk.builtin.rca import Rca
from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp
from flow_sdk.fs_store.schema_registry import SchemaRegistry

QA_TYPES = {
    "qa_phase": QAPhase, "qa_test_file": QATestFile, "qa_test": QATest, "qa_cycle": QACycle,
    "qa_iteration": QAIteration, "qa_test_result": QATestResult, "rca": Rca,
}


def test_every_qa_type_is_registered_with_its_class():
    for type_name, cls in QA_TYPES.items():
        assert SchemaRegistry.get_entity_cls(type_name) is cls, type_name


def test_test_results_and_tests_are_not_pushed_to_every_connection():
    """~29,000 results per iteration: Q tells its page through its own events instead."""
    hidden = {t for t in QA_TYPES if not SchemaRegistry.is_api_visible(t)}
    assert hidden == {"qa_test", "qa_test_result"}


@pytest.mark.asyncio
async def test_a_result_is_saved_and_found_by_its_iteration():
    cycle = await QACycle(cycle_id="qa-20261112-120000", name="nightly", repo="org/repo", branch="main", commit_sha="abc").save()
    iteration = await QAIteration(iteration_id="i01", cycle=cycle.id, order=1,
                                  planned={"phases": ["p1"], "test_files": [], "tests": []}).save()
    for attempt, status in ((1, "fail"), (2, "pass")):
        await QATestResult(cycle=cycle.id, iteration=iteration.id, phase="p1", test_file="f1", test_name="test_login",
                           attempt=attempt, status=status, attachments=["file-1"]).save()

    query = QueryFilter(type="qa_test_result")
    query.match = ExpressionNode(op=QueryOp.EQ, operands=["iteration", iteration.id])
    found = sorted(await QATestResult.get_all(query), key=lambda r: r.attempt)
    assert [(r.attempt, r.status) for r in found] == [(1, "fail"), (2, "pass")]
    assert found[0].attachments == ["file-1"]
    assert (await QAIteration.get_by_id(iteration.id)).planned == {"phases": ["p1"], "test_files": [], "tests": []}
