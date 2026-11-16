"""Type metadata for the QA entities (builtin/qa.py).

The plan and cycle rows are few and pushed like any visible type. Test executions (~29,000 per iteration on a big
repository) and test cases are not: Q tells its own page about them through its own events.

``natural_key`` is each row's identity: a create looks it up (``find_existing_for_create``) and mints a uuid4 only
on a miss. Each key is also the type's first index, so that lookup is one indexed read, not a scan of the type.
"""
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.types import EntityType

QA_PHASE = TypeInfo(
    type_name=EntityType.QA_PHASE, icon="Layers", api_visible=True,
    natural_key=("repo", "step"), indexes=(("repo", "step"),),
)
QA_TEST_FILE = TypeInfo(
    type_name=EntityType.QA_TEST_FILE, icon="FileCode", api_visible=True,
    natural_key=("repo", "path"), indexes=(("repo", "path"),),
)
QA_TEST_CASE = TypeInfo(
    type_name=EntityType.QA_TEST_CASE, icon="ListChecks", api_visible=False,
    natural_key=("test_file", "name"), indexes=(("test_file", "name"),),
)
QA_CYCLE = TypeInfo(
    type_name=EntityType.QA_CYCLE, icon="RefreshCw", api_visible=True,
    natural_key=("repo", "cycle_id"), indexes=(("repo", "cycle_id"),),
)
QA_ITERATION = TypeInfo(
    type_name=EntityType.QA_ITERATION, icon="Repeat", api_visible=True,
    natural_key=("cycle", "order"), indexes=(("cycle", "order"),),
)
QA_TEST_EXECUTION = TypeInfo(
    type_name=EntityType.QA_TEST_EXECUTION, icon="Play", api_visible=False,
    # One attempt at one test case in one iteration. Its leading ``iteration`` also serves "an iteration's executions".
    natural_key=("iteration", "test_file", "test_name", "attempt"),
    indexes=(("iteration", "test_file", "test_name", "attempt"),),
)
