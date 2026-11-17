"""Type metadata for the QA entities (builtin/qa.py).

**Each row is an asset**: an entity document ``<scope>/agentic-assets/<type>/<name>/<type>.json`` (``qa_spec``)
holding every field. The document is the record; the DB row is its index, rebuilt from the document after a clear.
A child nests in its parent's folder (``<parent>/agentic-assets/<type>/<name>/``): an iteration in its cycle, an
execution in its iteration, a test case in its test file. The entity is the documents' only writer, so every save
re-renders its document (``owns_main_ref``).

The plan and cycle rows are few and pushed like any visible type.

``natural_key`` is each row's identity: a create looks it up (``find_existing_for_create``) and mints a uuid4 only
on a miss. Each key is also the type's first index, so that lookup is one indexed read, not a scan of the type.
"""
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.data_spec.qa_spec import (
    QACycleSpec,
    QAIterationSpec,
    QAPhaseSpec,
    QATestCaseSpec,
    QATestExecutionSpec,
    QATestFileSpec,
)
from flow_sdk.schema.types import EntityType

_DOCUMENT = {"asset_class": "repo", "owns_main_ref": True}

QA_PHASE = TypeInfo(
    type_name=EntityType.QA_PHASE, icon="Layers", api_visible=True,
    family="qa_phase", asset_spec=QAPhaseSpec, **_DOCUMENT,
    natural_key=("repo", "step"), indexes=(("repo", "step"),),
)
QA_TEST_FILE = TypeInfo(
    type_name=EntityType.QA_TEST_FILE, icon="FileCode", api_visible=True,
    family="qa_test_file", asset_spec=QATestFileSpec, **_DOCUMENT,
    natural_key=("repo", "path"), indexes=(("repo", "path"),),
)
QA_TEST_CASE = TypeInfo(
    type_name=EntityType.QA_TEST_CASE, icon="ListChecks", api_visible=False,
    family="qa_test_case", asset_spec=QATestCaseSpec, **_DOCUMENT,
    natural_key=("parent_type_id", "name"), indexes=(("parent_type_id", "name"),),
)
QA_CYCLE = TypeInfo(
    type_name=EntityType.QA_CYCLE, icon="RefreshCw", api_visible=True,
    family="qa_cycle", asset_spec=QACycleSpec, **_DOCUMENT,
    natural_key=("repo", "label"), indexes=(("repo", "label"),),
)
QA_ITERATION = TypeInfo(
    type_name=EntityType.QA_ITERATION, icon="Repeat", api_visible=True,
    family="qa_iteration", asset_spec=QAIterationSpec, **_DOCUMENT,
    natural_key=("parent_type_id", "order"), indexes=(("parent_type_id", "order"),),
)
QA_TEST_EXECUTION = TypeInfo(
    type_name=EntityType.QA_TEST_EXECUTION, icon="Play", api_visible=False,
    family="qa_test_execution", asset_spec=QATestExecutionSpec, **_DOCUMENT,
    # One attempt at one test case in one iteration (its parent). Its leading ``parent_type_id`` also serves "an iteration's executions".
    natural_key=("parent_type_id", "test_file_id", "test_name", "attempt"),
    indexes=(("parent_type_id", "test_file_id", "test_name", "attempt"),),
)
