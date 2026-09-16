"""Creation preserves identity, existing bytes and cross-caller reservations."""
import asyncio

import pytest

from flow_sdk.assets.asset import Asset
from flow_sdk.assets.creation import AssetPathCollisionError, creation_reservation, ensure_asset_scaffold
from flow_sdk.assets.types.graph_workflow_doc import GraphWorkflowDoc
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.schema.data_spec.skill_spec import SkillSpec
from flow_sdk.schema.types import EntityType

ID = "1b2d6c12-026e-456c-a9ab-ee66951758da"


def test_create_rejects_occupied_destination_and_preserves_identity(tmp_path):
    path = tmp_path / ".agents/skills/sample"
    asset = Asset.create(path, type=EntityType.SKILL, spec=SkillSpec(name="sample", body="Original"))
    before = (path / "SKILL.md").read_bytes()
    with pytest.raises(AssetPathCollisionError):
        Asset.create(path, type=EntityType.SKILL, spec=SkillSpec(name="other", body="Changed"))
    assert (path / "SKILL.md").read_bytes() == before
    assert Asset.from_path(path).typeid == asset.typeid


@pytest.mark.asyncio
async def test_creation_reservation_reentrant_only_for_current_owner(tmp_path):
    info = SchemaRegistry.get(EntityType.SKILL)
    def enter():
        with creation_reservation(info, tmp_path):
            return True
    async def child():
        return enter()
    with creation_reservation(info, tmp_path):
        assert enter()
        with pytest.raises(AssetPathCollisionError):
            await asyncio.create_task(child())
        with pytest.raises(AssetPathCollisionError):
            await asyncio.to_thread(enter)
    assert enter()


def test_scaffold_preserves_existing_files_and_rejects_other_identity(tmp_path):
    path = tmp_path / "agentic-assets/graph_workflow/sample"
    path.mkdir(parents=True)
    (path / "display.json").write_text('{"custom": true}')
    ref = TypeId(type=EntityType.GRAPH_WORKFLOW, id=ID)
    ensure_asset_scaffold(path, ref, GraphWorkflowDoc(name="sample"))
    assert (path / "display.json").read_text() == '{"custom": true}'
    assert (path / "scripts").is_dir()
    (path / "graph.json").write_text('{"custom": "graph"}')
    ensure_asset_scaffold(path, ref, GraphWorkflowDoc(name="changed"))
    assert (path / "graph.json").read_text() == '{"custom": "graph"}'
    with pytest.raises(AssetPathCollisionError):
        ensure_asset_scaffold(path, TypeId(type=EntityType.GRAPH_WORKFLOW, id="8a4d1e77-0000-4000-8000-0000000000ff"), GraphWorkflowDoc())


@pytest.mark.parametrize("type_name", [EntityType.GRAPH_WORKFLOW, EntityType.JOURNEY])
def test_native_graph_creation_preserves_canonical_document_and_extensions(tmp_path, type_name):
    path = tmp_path / "agentic-assets" / type_name / "example"
    document = GraphWorkflowDoc(name="example", auto_launch=True, gate={"requires_capabilities": ["github"]})
    asset = Asset.create(path, type=type_name, spec=document)
    stored = GraphWorkflowDoc.model_validate_json((path / "graph.json").read_text())
    assert stored.id == asset.typeid.id
    assert stored.auto_launch is True
    assert stored.gate == document.gate
    assert not (path / "runs").exists()  # Main-document creation is not scaffolding.


def test_scaffold_foreign_identity_rejects_before_writing_defaults(tmp_path):
    path = tmp_path / "agentic-assets/graph_workflow/example"
    (path / ".flow").mkdir(parents=True)
    (path / ".flow/id").write_text(ID)
    with pytest.raises(AssetPathCollisionError):
        ensure_asset_scaffold(path, TypeId(type=EntityType.GRAPH_WORKFLOW, id=ID), GraphWorkflowDoc())
    assert not (path / "graph.json").exists()


def test_whiteboard_creation_and_missing_document_repair_preserve_authored_board(tmp_path):
    from flow_sdk.assets.document import read_document
    from flow_sdk.assets.types.whiteboard_spec import WhiteboardSpec

    path = tmp_path / 'agentic-assets' / 'whiteboard' / 'legacy'
    spec = WhiteboardSpec(name='Legacy board', description='Authored canvas')
    asset = Asset.create(path, type=EntityType.WHITEBOARD, spec=spec)
    main = path / 'WHITE_BOARD.md'
    assert read_document(main).fields['name'] == 'Legacy board'
    canvas = b'{"kind":"excalidraw","data":{"elements":[{"id":"existing"}]}}'
    (path / 'board.json').write_bytes(canvas)
    main.unlink()
    ensure_asset_scaffold(path, asset.typeid, spec)
    assert read_document(main).fields['id'] == asset.typeid.id
    assert (path / 'board.json').read_bytes() == canvas
    main.write_bytes(main.read_bytes() + b'Custom prose\n')
    authored = main.read_bytes()
    ensure_asset_scaffold(path, asset.typeid, WhiteboardSpec(name='Different'))
    assert main.read_bytes() == authored
    assert (path / 'board.json').read_bytes() == canvas
