"""Fast integration coverage at the identity-carrier ↔ TypeInfo seams:
markdown identity IS frontmatter ``id:``; folder-json types keep their
capsule; legacy markdown capsules are read and converted."""
from __future__ import annotations

import ast
from pathlib import Path

from flow_sdk.builtin.claude_memory_entities import Docs
from flow_sdk.capsules import AssetCapsule, CapsuleData
from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FrontMatterFsRef, FSRef
from flow_sdk.fs_store.indexer._frontmatter import _extract_frontmatter, _yaml_load
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.schema.type_info import register_all
from tests.unit._disk import store_main

IDENTITY = "7ce48c47-abab-4c9c-9780-a7198d12a260"


def setup_module() -> None:
    register_all()


def _fm(path: Path) -> dict:
    fm = _extract_frontmatter(path.read_text(encoding="utf-8"))
    return (_yaml_load(fm) or {}) if fm else {}


def test_file_creation_writes_the_id_as_the_first_frontmatter_key(tmp_path: Path) -> None:
    entity = Docs(id=IDENTITY, title="Frontmatter note", name="Frontmatter note")
    record = FSRecord(type=RecordType.MARKDOWN, id=IDENTITY)
    ref = record.compute_asset_ref(tmp_path, entity)
    assert ref is not None
    record.asset_ref = ref

    assert store_main(record, entity) == IDENTITY

    text = ref._path.read_text(encoding="utf-8")
    assert text.startswith(f"---\nid: {IDENTITY}\n")
    assert "flowpad:capsule" not in text
    parsed = SchemaRegistry.get("markdown").from_disk_fn(ref, IDENTITY)[0]
    assert parsed.id == IDENTITY
    assert "flowpad:capsule" not in parsed.body


def test_creation_adopts_existing_filesystem_winner_on_record(tmp_path: Path) -> None:
    path = tmp_path / "note.md"
    path.write_text(f"---\nid: {IDENTITY}\n---\n\nExisting body\n", encoding="utf-8")
    proposed = "11111111-2222-4333-8444-555555555555"
    record = FSRecord(type=RecordType.MARKDOWN, id=proposed, asset_ref=FSRef(path))
    entity = Docs(id=proposed, title="Ignored", name="Ignored")

    assert store_main(record, entity) == IDENTITY
    assert record.id == IDENTITY
    assert _fm(path)["id"] == IDENTITY


def test_owned_folder_rewrite_keeps_the_id_in_the_main_document(tmp_path: Path) -> None:
    from flow_sdk.builtin.task import Task

    task = Task(id=IDENTITY, title="Before", description="first")
    record = FSRecord(type=RecordType.TASK, id=IDENTITY)
    ref = record.compute_asset_ref(tmp_path, task)
    assert ref is not None
    record.asset_ref = ref
    assert store_main(record, task) == IDENTITY

    main = ref._path / "task.md"
    assert _fm(main)["id"] == IDENTITY
    assert not (ref._path / ".flow" / "capsules").exists(), "a folder with a markdown main writes no json capsule"
    task.title = "After"
    task.description = "second"
    assert store_main(record, task) == IDENTITY

    body = main.read_text(encoding="utf-8")
    assert body.startswith(f"---\nid: {IDENTITY}\n"), "an owned re-render keeps the id first"
    assert "After" in body and "second" in body
    assert "flowpad:capsule" not in body


def test_frontmatter_editor_preserves_the_id_and_a_legacy_capsule(tmp_path: Path) -> None:
    path = tmp_path / "note.md"
    path.write_text(f"---\nid: {IDENTITY}\ntitle: Note\n---\n\nOld body\n", encoding="utf-8")
    ref = FrontMatterFsRef(path)
    ref.write_body("New body\n")
    assert _fm(path) == {"id": IDENTITY, "title": "Note"}
    assert ref.read_body().strip() == "New body"

    AssetCapsule.from_path(path).write("identity", CapsuleData(version=1, data={"id": IDENTITY}))
    ref.write_body("Newer body\n")
    assert ref.read_body().strip() == "Newer body", "a not-yet-converted capsule stays out of the body"


def test_source_less_bundle_body_mints_proposed_identity(tmp_path: Path) -> None:
    from flow_sdk.builtin.flow_message_bundle import _mint_rendered_asset_identity

    info = SchemaRegistry.get(str(RecordType.SUBAGENT))
    assert info is not None
    body = tmp_path / "agent.md"
    body.write_text("---\nname: Agent\n---\n\nPrompt\n", encoding="utf-8")

    assert _mint_rendered_asset_identity(info, body, str(RecordType.SUBAGENT), IDENTITY) == IDENTITY
    assert _fm(body) == {"id": IDENTITY, "name": "Agent"}


def test_production_has_no_alternate_identity_writers() -> None:
    """Every carrier write goes through ``identity_backend.py``: no caller
    writes a frontmatter ``id:`` or a folder json capsule
    on its own."""
    sdk_root = Path(__file__).parents[2] / "flow_sdk"
    legacy_writers = {"write_frontmatter_id"}
    violations: list[str] = []
    search_roots = (sdk_root / "fs_store", sdk_root / "schema" / "type_info")
    paths = [path for root in search_roots for path in root.rglob("*.py")]
    paths.extend(
        sdk_root / relative
        for relative in (
            "app/actions/message_attachment_action.py",
            "builtin/flow_message_bundle.py",
            "core/entity/entity_model.py",
            "graph_workflow_manager/service_graph_workflows.py",
        )
    )
    for path in paths:
        source = path.read_text(encoding="utf-8")
        if not any(token in source for token in (*legacy_writers, '"identity"', "'identity'")):
            continue
        tree = ast.parse(source, filename=str(path))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            called = node.func.id if isinstance(node.func, ast.Name) else (
                node.func.attr if isinstance(node.func, ast.Attribute) else None
            )
            if called in legacy_writers:
                violations.append(f"{path.relative_to(sdk_root)}:{node.lineno}:{called}")
            if (
                called in {"write", "write_if_absent"}
                and node.args
                and isinstance(node.args[0], ast.Constant)
                and node.args[0].value == "identity"
                and path.name != "identity_carrier.py"
            ):
                violations.append(f"{path.relative_to(sdk_root)}:{node.lineno}:direct identity capsule write")
    assert violations == []
