"""A creatable dynamic_workflow materializes a .js file (not the .md default)."""
import flow_sdk.fs_store.indexer.registrations  # noqa: F401  (register types)
from flow_sdk.builtin.dynamic_workflow import DynamicWorkflow
from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.schema_registry import SchemaRegistry


def test_dynamic_workflow_asset_ref_is_js(tmp_path):
    rec = FSRecord(type=RecordType.DYNAMIC_WORKFLOW, name="Demo Flow")
    ar = rec.compute_asset_ref(tmp_path, DynamicWorkflow(name="Demo Flow"))
    assert str(ar._path).endswith(".claude/workflows/demo_flow.js")


def test_markdown_family_still_defaults_to_md():
    # The default extension is unchanged for the markdown-asset family.
    assert SchemaRegistry.get("dynamic_workflow").main_ext == ".js"
    assert SchemaRegistry.get("workflow").main_ext == ".md"
