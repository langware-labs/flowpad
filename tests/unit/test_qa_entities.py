"""The QA entities (builtin/qa.py) and the generic Rca (builtin/rca.py): which types are pushed to every connection."""
from flow_sdk.builtin.qa import QACycle, QAIteration, QAPhase, QATestCase, QATestFile, QATestExecution
from flow_sdk.builtin.rca import Rca
from flow_sdk.fs_store.schema_registry import SchemaRegistry

QA_TYPES = {
    "qa_phase": QAPhase, "qa_test_file": QATestFile, "qa_test_case": QATestCase, "qa_cycle": QACycle,
    "qa_iteration": QAIteration, "qa_test_execution": QATestExecution, "rca": Rca,
}


def test_test_executions_and_test_cases_are_not_pushed_to_every_connection():
    """~29,000 executions per iteration: too many to push to every connection."""
    hidden = {t for t in QA_TYPES if not SchemaRegistry.is_api_visible(t)}
    assert hidden == {"qa_test_case", "qa_test_execution"}
