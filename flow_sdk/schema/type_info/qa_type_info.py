"""Type metadata for the QA entities (builtin/qa.py).

The plan and cycle rows are few and pushed like any visible type. Test executions (~29,000 per iteration on a big
repository) and test cases are not: Q tells its own page about them through its own events.
"""
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.types import EntityType

QA_PHASE = TypeInfo(type_name=EntityType.QA_PHASE, icon="Layers", api_visible=True)
QA_TEST_FILE = TypeInfo(type_name=EntityType.QA_TEST_FILE, icon="FileCode", api_visible=True)
QA_TEST_CASE = TypeInfo(type_name=EntityType.QA_TEST_CASE, icon="FlaskConical", api_visible=False)
QA_CYCLE = TypeInfo(type_name=EntityType.QA_CYCLE, icon="RefreshCw", api_visible=True)
QA_ITERATION = TypeInfo(type_name=EntityType.QA_ITERATION, icon="Repeat", api_visible=True)
QA_TEST_EXECUTION = TypeInfo(type_name=EntityType.QA_TEST_EXECUTION, icon="CircleCheck", api_visible=False)
