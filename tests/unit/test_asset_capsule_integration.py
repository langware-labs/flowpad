"""Fast integration coverage at the AssetCapsule ↔ TypeInfo seams."""
from __future__ import annotations

import ast
from pathlib import Path
from types import SimpleNamespace

from flow_sdk.capsules import AssetCapsule, CapsuleData, snapshot_capsule_blocks
from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FrontMatterFsRef, FSRef
from flow_sdk.fs_store.indexer._frontmatter import _extract_frontmatter, _yaml_load
from flow_sdk.fs_store.indexer.functions.markdown import extract_markdown
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.schema.type_info import register_all

IDENTITY = "7ce48c47-abab-4c9c-9780-a7198d12a260"


def setup_module() -> None:
    register_all()


def test_file_creation_mints_capsule_after_body_without_frontmatter_id(tmp_path: Path) -> None:
    entity = SimpleNamespace(id=IDENTITY, title="Capsule note", name="Capsule note")
    record = FSRecord(type=RecordType.MARKDOWN, id=IDENTITY)
    ref = record.compute_asset_ref(tmp_path, entity)
    assert ref is not None
    record.asset_ref = ref

    assert record.upsert_main_ref(entity) == IDENTITY

    text = ref._path.read_text(encoding="utf-8")
    assert "id" not in (_yaml_load(_extract_frontmatter(text)) or {})
    assert AssetCapsule.from_path(ref._path).read("identity") == CapsuleData(
        version=1, data={"id": IDENTITY}
    )
    parsed = extract_markdown(ref, IDENTITY)[0]
    assert "flowpad:capsule" not in parsed.body
    assert "flowpad:capsule" not in parsed.content


def test_creation_adopts_existing_filesystem_winner_on_record(tmp_path: Path) -> None:
    path = tmp_path / "note.md"
    path.write_text("Existing body\n", encoding="utf-8")
    AssetCapsule.from_path(path).write(
        "identity", CapsuleData(version=1, data={"id": IDENTITY})
    )
    proposed = "11111111-2222-4333-8444-555555555555"
    record = FSRecord(type=RecordType.MARKDOWN, id=proposed, asset_ref=FSRef(path))
    entity = SimpleNamespace(id=proposed, title="Ignored", name="Ignored")

    assert record.upsert_main_ref(entity) == IDENTITY
    assert record.id == IDENTITY
    assert AssetCapsule.from_path(path).read("identity").data["id"] == IDENTITY


def test_owned_folder_rewrite_preserves_raw_capsule(tmp_path: Path) -> None:
    from flow_sdk.builtin.task import Task

    task = Task(id=IDENTITY, title="Before", description="first")
    record = FSRecord(type=RecordType.TASK, id=IDENTITY)
    ref = record.compute_asset_ref(tmp_path, task)
    assert ref is not None
    record.asset_ref = ref
    assert record.upsert_main_ref(task) == IDENTITY

    capsule_file = ref._path / ".flow" / "capsules" / "identity.json"
    original_capsule = capsule_file.read_bytes()
    task.title = "After"
    task.description = "second"
    assert record.upsert_main_ref(task) == IDENTITY

    assert capsule_file.read_bytes() == original_capsule
    body = (ref._path / "task.md").read_text(encoding="utf-8")
    assert "After" in body and "second" in body
    assert "flowpad:capsule" not in body  # folder identity lives in JSON


def test_frontmatter_editor_preserves_capsule_and_hides_it_from_body(tmp_path: Path) -> None:
    path = tmp_path / "note.md"
    path.write_text("---\ntitle: Note\n---\n\nOld body\n", encoding="utf-8")
    capsule = AssetCapsule.from_path(path)
    capsule.write("identity", CapsuleData(version=1, data={"id": IDENTITY}))
    before = snapshot_capsule_blocks(path.read_text(encoding="utf-8"))

    ref = FrontMatterFsRef(path)
    ref.write_body("New body\n")

    assert snapshot_capsule_blocks(path.read_text(encoding="utf-8")) == before
    assert capsule.read("identity").data["id"] == IDENTITY
    assert ref.read_body().strip() == "New body"


def test_source_less_bundle_body_mints_proposed_identity(tmp_path: Path) -> None:
    from flow_sdk.builtin.flow_message_bundle import _mint_rendered_asset_identity
    from flow_sdk.fs_store.schema_registry import SchemaRegistry

    info = SchemaRegistry.get(str(RecordType.AGENT))
    assert info is not None
    body = tmp_path / "agent.md"
    body.write_text("---\nname: Agent\n---\n\nPrompt\n", encoding="utf-8")

    assert _mint_rendered_asset_identity(info, body, str(RecordType.AGENT), IDENTITY) == IDENTITY
    assert AssetCapsule.from_path(body).read("identity").data["id"] == IDENTITY


def test_production_has_no_alternate_identity_writers() -> None:
    """Keep legacy carriers read-only and canonical writes behind the backend."""
    sdk_root = Path(__file__).parents[2] / "flow_sdk"
    legacy_writers = {"write_frontmatter_id", "write_folder_capsule_id"}
    violations: list[str] = []
    search_roots = (
        sdk_root / "fs_store",
        sdk_root / "schema" / "type_info",
    )
    paths = [path for root in search_roots for path in root.rglob("*.py")]
    paths.extend(
        sdk_root / relative
        for relative in (
            "app/actions/message_attachment_action.py",
            "builtin/flow_message_bundle.py",
            "core/entity/entity_model.py",
            "flow_manager/service_flows.py",
        )
    )

    for path in paths:
        source = path.read_text(encoding="utf-8")
        if not any(
            token in source
            for token in (*legacy_writers, '"identity"', "'identity'")
        ):
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
                and path.name != "identity_backend.py"
            ):
                violations.append(
                    f"{path.relative_to(sdk_root)}:{node.lineno}:direct identity capsule write"
                )

    assert violations == []
