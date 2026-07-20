"""Fast, no-mock contract matrix for every registered filesystem identity."""
from __future__ import annotations

import json
import uuid
from pathlib import Path

import pytest

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer._frontmatter import read_frontmatter_id
from flow_sdk.fs_store.indexer.functions._folder_capsule import read_folder_capsule_id
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.schema.types import EntityType

V4 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
V5 = str(uuid.uuid5(uuid.NAMESPACE_URL, "identity-matrix"))
V7 = "018f0000-0000-7000-8000-000000000000"

INDEXED_TYPES = {
    "agent_trace", "agent", "agentic_flow", "asset_cleanup_report",
    "claude_hook", "claude_md", "claude_memory", "claude_rules",
    "claude_session", "codex_session", "command", "copilot_session",
    "dataset", "deck_template", "deck", "dynamic_workflow",
    "markdown_index", "markdown", "mcp_server", "plan", "plugin",
    "project", "prompt", "secret_origin", "skill", "spec", "spreadsheet",
    "task", "todo_file", "usage_report", "whiteboard", "workflow_run",
}

FRONTMATTER_PORTABLE = ("agent", "claude_md", "markdown")
FRONTMATTER_STABLE = ("plan", "claude_memory", "claude_rules", "spec", "prompt")
FRONTMATTER_ALL = FRONTMATTER_PORTABLE + FRONTMATTER_STABLE + ("command",)
FOLDER_PORTABLE = (
    "agentic_flow", "dataset", "deck", "deck_template", "skill", "task", "whiteboard",
)
JSON_STABLE = ("agent_trace", "asset_cleanup_report", "usage_report")


def _info(type_name: str):
    import flow_sdk.fs_store.indexer.registrations  # noqa: F401

    info = SchemaRegistry.get(type_name)
    assert info is not None
    return info


def _frontmatter(path: Path, *, canonical: str | None = None, legacy: str | None = None) -> None:
    rows = ["---"]
    if canonical is not None:
        rows.append(f"id: {canonical}")
    if legacy is not None:
        rows.append(f"asset_id: {legacy}")
    rows.extend(["name: Matrix", "---", "", "body"])
    path.write_text("\n".join(rows), encoding="utf-8")


def test_every_registered_extractor_has_one_identity_reader() -> None:
    canonical_types = {str(entity_type) for entity_type in EntityType}
    actual = {
        name for name in SchemaRegistry.get_all_types()
        if name in canonical_types
        and (info := SchemaRegistry.get(name)) is not None
        and info.from_disk_fn is not None
    }
    assert actual == INDEXED_TYPES
    for name in sorted(actual):
        info = _info(name)
        readers = [info.id_from_file_fn, info.id_from_folder_fn]
        assert sum(reader is not None for reader in readers) == 1, name


@pytest.mark.parametrize("type_name", FRONTMATTER_ALL)
@pytest.mark.parametrize("existing", (V4, V5))
def test_file_canonical_id_is_adopted_unchanged_without_write(
    tmp_path: Path, type_name: str, existing: str,
) -> None:
    path = tmp_path / "asset.md"
    _frontmatter(path, canonical=existing)
    before = path.read_bytes()
    info = _info(type_name)
    assert info.extract_id(path) == existing
    assert info.mint_id(path) == existing
    assert path.read_bytes() == before


@pytest.mark.parametrize("type_name", FRONTMATTER_ALL)
def test_file_invalid_canonical_does_not_mask_valid_legacy(
    tmp_path: Path, type_name: str,
) -> None:
    path = tmp_path / "asset.md"
    _frontmatter(path, canonical=V7, legacy=V5)
    before = path.read_bytes()
    assert _info(type_name).mint_id(path) == V5
    assert path.read_bytes() == before, "legacy adoption never cleans/backfills"


@pytest.mark.parametrize("type_name", FRONTMATTER_PORTABLE)
def test_missing_portable_file_mints_persists_and_is_idempotent(
    tmp_path: Path, type_name: str,
) -> None:
    path = tmp_path / "asset.md"
    path.write_text("body", encoding="utf-8")
    info = _info(type_name)
    first = info.mint_id(path)
    assert uuid.UUID(first).version == 4
    assert read_frontmatter_id(path) == first
    assert info.mint_id(path) == first


@pytest.mark.parametrize("type_name", FRONTMATTER_STABLE)
def test_missing_stable_file_mints_exact_path_v5_and_persists(
    tmp_path: Path, type_name: str,
) -> None:
    path = tmp_path / "asset.md"
    path.write_text("body", encoding="utf-8")
    expected = str(uuid.uuid5(uuid.NAMESPACE_URL, str(path.resolve())))
    info = _info(type_name)
    assert info.mint_id(path) == expected


def test_missing_command_uses_scope_natural_key_dns_v5_and_persists(tmp_path: Path) -> None:
    path = tmp_path / "deploy.md"
    path.write_text("body", encoding="utf-8")
    ref = FSRef(path, scope="project")
    expected = str(uuid.uuid5(uuid.NAMESPACE_DNS, "command:project:deploy"))
    info = _info("command")
    assert info.mint_id(ref) == expected
    assert read_frontmatter_id(path) == expected
    assert read_frontmatter_id(path) == expected
    assert info.mint_id(path) == expected


@pytest.mark.parametrize("type_name", FOLDER_PORTABLE)
@pytest.mark.parametrize("existing", (V4, V5))
def test_folder_capsule_adopted_unchanged_without_write(
    tmp_path: Path, type_name: str, existing: str,
) -> None:
    folder = tmp_path / type_name
    (folder / ".flow").mkdir(parents=True)
    capsule = folder / ".flow" / "id"
    capsule.write_text(existing + "\n", encoding="utf-8")
    before = capsule.read_bytes()
    info = _info(type_name)
    assert info.extract_id(folder) == existing
    assert info.mint_id(folder) == existing
    assert capsule.read_bytes() == before


@pytest.mark.parametrize("type_name", FOLDER_PORTABLE)
def test_missing_folder_id_mints_persists_and_is_idempotent(
    tmp_path: Path, type_name: str,
) -> None:
    folder = tmp_path / type_name
    folder.mkdir()
    info = _info(type_name)
    first = info.mint_id(folder)
    assert uuid.UUID(first).version == 4
    assert read_folder_capsule_id(folder) == first
    assert info.mint_id(folder) == first


def _folder_with_legacy(root: Path, type_name: str) -> Path:
    folder = root / type_name
    folder.mkdir()
    (folder / ".flow").mkdir()
    (folder / ".flow" / "id").write_text(V7, encoding="utf-8")
    if type_name == "skill":
        _frontmatter(folder / "SKILL.md", canonical=V7, legacy=V5)
    elif type_name == "whiteboard":
        _frontmatter(folder / "WHITE_BOARD.md", canonical=V7, legacy=V5)
    elif type_name == "task":
        _frontmatter(folder / "task.md", canonical=V7, legacy=V5)
    elif type_name == "dataset":
        (folder / "dataset.json").write_text(json.dumps({"metadata": {"id": V5}, "data": {}}))
    elif type_name == "deck":
        (folder / "deck.json").write_text(json.dumps({"id": V5}))
    elif type_name == "deck_template":
        (folder / "template.json").write_text(json.dumps({"metadata": {"id": V5}, "data": {}}))
    elif type_name == "agentic_flow":
        (folder / "graph.json").write_text(json.dumps({"id": V5, "nodes": [], "edges": []}))
    return folder


@pytest.mark.parametrize("type_name", FOLDER_PORTABLE)
def test_invalid_folder_capsule_falls_through_to_valid_legacy_without_backfill(
    tmp_path: Path, type_name: str,
) -> None:
    folder = _folder_with_legacy(tmp_path, type_name)
    capsule = folder / ".flow" / "id"
    before = capsule.read_bytes()
    assert _info(type_name).mint_id(folder) == V5
    assert capsule.read_bytes() == before


def test_markdown_default_body_carries_allocated_id() -> None:
    from types import SimpleNamespace

    from flow_sdk.schema.type_info.markdown_type_info import _markdown_default_body

    body = _markdown_default_body(SimpleNamespace(id=V4, name="A", title="A"))
    assert f"id: {V4}" in body
    assert "# A" in body


@pytest.mark.parametrize("type_name", JSON_STABLE)
@pytest.mark.parametrize("existing", (V4, V5))
def test_json_canonical_id_is_adopted_unchanged(
    tmp_path: Path, type_name: str, existing: str,
) -> None:
    path = tmp_path / "report.json"
    path.write_text(json.dumps({"id": existing, "name": "R"}) + "\n", encoding="utf-8")
    before = path.read_bytes()
    info = _info(type_name)
    assert info.extract_id(path) == existing
    assert info.mint_id(path) == existing
    assert path.read_bytes() == before


@pytest.mark.parametrize("type_name", JSON_STABLE)
def test_missing_json_id_mints_exact_path_v5_and_persists(
    tmp_path: Path, type_name: str,
) -> None:
    path = tmp_path / "report.json"
    path.write_text('{"name": "R"}\n', encoding="utf-8")
    expected = str(uuid.uuid5(uuid.NAMESPACE_URL, str(path.resolve())))
    info = _info(type_name)
    assert info.mint_id(path) == expected
    assert json.loads(path.read_text(encoding="utf-8"))["id"] == expected


def _deterministic_case(root: Path, type_name: str) -> tuple[FSRef, str, uuid.UUID]:
    path = root / f"{type_name}.asset"
    namespace = uuid.NAMESPACE_URL
    if type_name == "claude_hook":
        ref = FSRef(path, json_path="/hooks/pre")
        return ref, "claude_hook:user:/hooks/pre", uuid.NAMESPACE_DNS
    if type_name == "claude_session":
        path.write_text('{"sessionId":"raw-session"}\n', encoding="utf-8")
        return FSRef(path), "claude_session:raw-session", uuid.NAMESPACE_DNS
    if type_name == "codex_session":
        path.write_text('{"type":"session_meta","payload":{"id":"raw-thread"}}\n', encoding="utf-8")
        return FSRef(path), "codex_session:raw-thread", uuid.NAMESPACE_DNS
    if type_name == "copilot_session":
        folder = root / "raw-copilot"
        folder.mkdir()
        return FSRef(folder / "events.jsonl"), "copilot_session:raw-copilot", uuid.NAMESPACE_DNS
    if type_name == "dynamic_workflow":
        path.write_text("export const meta = {name: 'W'};", encoding="utf-8")
        return FSRef(path), f"dynamic_workflow:{path.resolve()}", namespace
    if type_name == "markdown_index":
        return FSRef(path), str(path.resolve()), namespace
    if type_name == "mcp_server":
        ref = FSRef(path, json_path="/mcpServers/demo")
        return ref, f"mcp_server:{path}:demo", uuid.NAMESPACE_DNS
    if type_name == "plugin":
        ref = FSRef(path, json_path="/plugins/demo@market/0")
        return ref, "plugin:demo@market", uuid.NAMESPACE_DNS
    if type_name == "project":
        return FSRef(path), f"project-fsref:{path}", uuid.NAMESPACE_DNS
    if type_name == "secret_origin":
        path.write_text(json.dumps({"data": {"locator": {"kind": "local", "sod_name": "demo"}}}))
        return FSRef(path), "secret-origin:local:demo", namespace
    if type_name == "spreadsheet":
        return FSRef(path), str(path.resolve()), namespace
    if type_name == "todo_file":
        return FSRef(path), "todo_file:todo:todo_file", uuid.NAMESPACE_DNS
    if type_name == "workflow_run":
        path.write_text('{"runId":"wf_raw"}', encoding="utf-8")
        return FSRef(path), "wf_raw", namespace
    raise AssertionError(type_name)


DETERMINISTIC_TYPES = (
    "claude_hook", "claude_session", "codex_session", "copilot_session",
    "dynamic_workflow", "markdown_index", "mcp_server", "plugin", "project",
    "secret_origin", "spreadsheet", "todo_file", "workflow_run",
)


@pytest.mark.parametrize("type_name", DETERMINISTIC_TYPES)
def test_deterministic_provider_exact_v5_matrix(tmp_path: Path, type_name: str) -> None:
    ref, stable_key, namespace = _deterministic_case(tmp_path, type_name)
    info = _info(type_name)
    assert info.extract_id(ref) is None
    assert info.id_stable_key_fn(ref) == stable_key
    assert info.mint_id(ref) == str(uuid.uuid5(namespace, stable_key))


@pytest.mark.parametrize("type_name", ("claude_session", "codex_session", "copilot_session", "dynamic_workflow", "secret_origin"))
def test_provider_embedded_valid_id_is_adopted(tmp_path: Path, type_name: str) -> None:
    path = tmp_path / "asset"
    if type_name == "claude_session":
        path.write_text(json.dumps({"sessionId": V4}) + "\n")
        ref = FSRef(path)
    elif type_name == "codex_session":
        path.write_text(json.dumps({"type": "session_meta", "payload": {"id": V4}}) + "\n")
        ref = FSRef(path)
    elif type_name == "copilot_session":
        folder = tmp_path / V4
        folder.mkdir()
        ref = FSRef(folder / "events.jsonl")
    elif type_name == "dynamic_workflow":
        path.write_text(f"export const meta = {{id: '{V4}'}};")
        ref = FSRef(path)
    else:
        path.write_text(json.dumps({"data": {"id": V4}}))
        ref = FSRef(path)
    assert _info(type_name).mint_id(ref) == V4
