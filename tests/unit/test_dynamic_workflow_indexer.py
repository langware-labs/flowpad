"""DYNAMIC_WORKFLOW walker — emits a record per .js, both in
.claude/workflows/ and skill-bundled in .claude/skills/<name>/."""
from pathlib import Path

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.indexer.functions.dynamic_workflows import dynamic_workflows_fn

# A root holding both a top-level workflow and a skill-bundled one.
ROOT = Path(__file__).parents[1] / "fixtures/dynamic_workflows"


def test_walker_emits_workflows_and_skill_bundled_js():
    node = FSRef(ROOT, record_type=RecordType.PROJECT)
    refs = dynamic_workflows_fn([node], None)
    assert all(r.record_type == RecordType.DYNAMIC_WORKFLOW for r in refs)
    names = sorted(r._path.name for r in refs)
    # sample-flow.js from .claude/workflows/, flow.js from .claude/skills/demo-skill/
    assert names == ["flow.js", "sample-flow.js"]
