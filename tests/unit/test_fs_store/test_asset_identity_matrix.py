"""Fast, no-mock contract matrix for every registered filesystem identity."""
from __future__ import annotations

import inspect
import json
import uuid
from pathlib import Path

import pytest

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.identity_carrier import (
    DerivedCarrier,
    FolderJsonCarrier,
    FrontmatterCarrier,
    NativeJsonCarrier,
)
from flow_sdk.fs_store.indexer._frontmatter import read_frontmatter_id
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.schema.types import EntityType

V4 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
V5 = str(uuid.uuid5(uuid.NAMESPACE_URL, "identity-matrix"))
V7 = "018f0000-0000-7000-8000-000000000000"

INDEXED_TYPES = {
    "agent_trace", "subagent", "agent", "graph_workflow", "asset_cleanup_report",
    "claude_hook", "claude_md", "claude_memory", "claude_rules",
    "claude_session", "codex_session", "command", "copilot_session",
    "credential_spec", "data_source_spec",
    "dataset", "deck_template", "deck", "dynamic_workflow",
    "helpdesk", "journey", "markdown_index", "markdown", "mcp", "mcp_server", "micro_app", "plan", "plugin",
    "project", "prompt", "secret_origin", "skill", "spec", "spreadsheet",
    "task", "todo_file", "usage_report", "whiteboard", "workflow_run",
}

FRONTMATTER_PORTABLE = ("subagent", "agent", "claude_md", "markdown")
FRONTMATTER_STABLE = ("plan", "claude_memory", "claude_rules", "spec", "prompt")
FRONTMATTER_ALL = FRONTMATTER_PORTABLE + FRONTMATTER_STABLE + ("command",)
FOLDER_PORTABLE = (
    "graph_workflow", "dataset", "deck", "deck_template", "journey", "skill", "task",
    "whiteboard",
)
#: Folder-capsule types with NO legacy reader. A legacy reader migrates ids
#: minted before the capsule scheme existed; a type introduced after it has no
#: such history, so declaring one would be dead by construction. They still
#: mint + persist + adopt like the rest — only the ``.flow/id`` fallback is
#: absent — so they join the capsule partition but skip the legacy cases.
FOLDER_NO_LEGACY = ("mcp",)
FOLDER_CAPSULE = FOLDER_PORTABLE + FOLDER_NO_LEGACY
JSON_STABLE = ("agent_trace", "asset_cleanup_report", "usage_report")


def _info(type_name: str):
    import flow_sdk.fs_store.indexer.registrations  # noqa: F401

    info = SchemaRegistry.get(type_name)
    assert info is not None
    return info


def _own_document(tmp_path: Path, type_name: str, default: str) -> Path:
    """A file the type CLAIMS: its declared main document for a folder type
    (``agent.md``, ``trace.json``), its fixed filename for a named file type
    (``CLAUDE.md``), else ``default``. The seam writes an id only into a path
    of the type's own shape (FLOWPAD-2083) — the same gate every walker
    applies — so a mint-and-persist case must present one."""
    info = _info(type_name)
    names = getattr(info.shape, "names", ())
    return tmp_path / (info.main_file or (names[0] if names else default))


def _frontmatter(path: Path, *, canonical: str | None = None, legacy: str | None = None) -> None:
    rows = ["---"]
    if canonical is not None:
        rows.append(f"id: {canonical}")
    if legacy is not None:
        rows.append(f"asset_id: {legacy}")
    rows.extend(["name: Matrix", "---", "", "body"])
    path.write_text("\n".join(rows), encoding="utf-8")


def test_every_registered_extractor_has_one_identity_backend() -> None:
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
        assert info.identity_carrier is not None, name


def test_exact_capsule_native_derived_partition_and_parser_contract() -> None:
    capsule_types = set(FRONTMATTER_ALL) | set(FOLDER_CAPSULE)
    native_types = set(JSON_STABLE)
    derived_types = INDEXED_TYPES - capsule_types - native_types
    # 19 capsule: base's 17 + `agent` + `mcp` (an MCP we AUTHOR carries its own
    # v4; the sibling `mcp_server` SCAN is derived, because its source is a
    # vendor config file we cannot write an id into). 17 derived: + `micro_app`,
    # whose webapp.json carries no id, and + `credential_spec`, whose
    # credential.json deliberately carries none either so a shipped definition
    # has the same id on every machine. Both are only half an answer: a derived
    # carrier says the id is NOT in the file, so the type still owes an
    # install-independent key. See
    # `test_shipped_asset_declares_an_install_independent_key`.
    assert (len(capsule_types), len(native_types), len(derived_types)) == (19, 3, 17)

    for name in sorted(INDEXED_TYPES):
        info = _info(name)
        # A markdown main document carries its id in its frontmatter; a folder
        # whose main is JSON keeps the json capsule.
        expected_backend = (
            (FrontmatterCarrier, FolderJsonCarrier) if name in capsule_types
            else NativeJsonCarrier if name in native_types
            else DerivedCarrier
        )
        assert isinstance(info.identity_carrier, expected_backend), name
        assert tuple((spec.name, spec.version) for spec in info.capsules) == (
            (("identity", 1),) if name in capsule_types else ()
        ), name
        parameters = list(inspect.signature(info.from_disk_fn).parameters.values())
        assert [parameter.name for parameter in parameters[:2]] == ["ref", "resolved_id"], name


@pytest.mark.parametrize("type_name", FRONTMATTER_ALL)
@pytest.mark.parametrize("existing", (V4, V5))
def test_file_canonical_id_is_adopted_unchanged_without_write(
    tmp_path: Path, type_name: str, existing: str,
) -> None:
    path = _own_document(tmp_path, type_name, "asset.md")
    _frontmatter(path, canonical=existing)
    before = path.read_bytes()
    info = _info(type_name)
    assert info.mint_entity_id(path) == existing
    assert info.mint_entity_id(path) == existing
    assert path.read_bytes() == before


@pytest.mark.parametrize("type_name", FRONTMATTER_ALL)
def test_file_invalid_canonical_does_not_mask_valid_legacy(
    tmp_path: Path, type_name: str,
) -> None:
    path = _own_document(tmp_path, type_name, "asset.md")
    _frontmatter(path, canonical=V7, legacy=V5)
    before = path.read_bytes()
    assert _info(type_name).mint_entity_id(path) == V5
    assert path.read_bytes() == before, "legacy adoption never cleans/backfills"


@pytest.mark.parametrize("type_name", FRONTMATTER_PORTABLE)
def test_missing_portable_file_mints_persists_and_is_idempotent(
    tmp_path: Path, type_name: str,
) -> None:
    path = _own_document(tmp_path, type_name, "asset.md")
    path.write_text("body", encoding="utf-8")
    info = _info(type_name)
    first = info.mint_entity_id(path)
    assert uuid.UUID(first).version == 4
    assert read_frontmatter_id(path) == first
    assert info.mint_entity_id(path) == first


@pytest.mark.parametrize("type_name", FRONTMATTER_STABLE)
def test_missing_stable_file_mints_exact_path_v5_and_persists(
    tmp_path: Path, type_name: str,
) -> None:
    path = _own_document(tmp_path, type_name, "asset.md")
    path.write_text("body", encoding="utf-8")
    expected = str(uuid.uuid5(uuid.NAMESPACE_URL, str(path.resolve())))
    info = _info(type_name)
    assert info.mint_entity_id(path) == expected


def test_missing_command_uses_scope_natural_key_dns_v5_and_persists(tmp_path: Path) -> None:
    path = tmp_path / "deploy.md"
    path.write_text("body", encoding="utf-8")
    ref = FSRef(path, scope="project")
    expected = str(uuid.uuid5(uuid.NAMESPACE_DNS, "command:project:deploy"))
    info = _info("command")
    assert info.mint_entity_id(ref) == expected
    assert read_frontmatter_id(path) == expected
    assert info.mint_entity_id(path) == expected


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
    assert info.mint_entity_id(folder) == existing
    assert info.mint_entity_id(folder) == existing
    assert capsule.read_bytes() == before


@pytest.mark.parametrize("type_name", FOLDER_CAPSULE)
def test_missing_folder_id_mints_persists_and_is_idempotent(
    tmp_path: Path, type_name: str,
) -> None:
    folder = tmp_path / type_name
    folder.mkdir()
    info = _info(type_name)
    first = info.mint_entity_id(folder)
    assert uuid.UUID(first).version == 4
    assert info.read_id(folder) == first, "persisted in the folder's carrier (json capsule; a main doc's header when one exists)"
    assert info.mint_entity_id(folder) == first


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
    elif type_name in ("graph_workflow", "journey"):
        (folder / "graph.json").write_text(json.dumps({"id": V5, "nodes": [], "edges": []}))
    return folder


@pytest.mark.parametrize("type_name", FOLDER_PORTABLE)
def test_invalid_folder_capsule_falls_through_to_valid_legacy_without_backfill(
    tmp_path: Path, type_name: str,
) -> None:
    folder = _folder_with_legacy(tmp_path, type_name)
    capsule = folder / ".flow" / "id"
    before = capsule.read_bytes()
    assert _info(type_name).mint_entity_id(folder) == V5
    assert capsule.read_bytes() == before


def test_markdown_render_puts_identity_first_in_frontmatter() -> None:
    from flow_sdk.builtin.claude_memory_entities import Docs

    info = _info("markdown")
    text = info.serializer().render(Docs(id=V4, name="A", title="A"), info)
    assert text.startswith(f"---\nid: {V4}\n"), "the header IS the carrier: an owned render keeps the id first"
    assert "title: A" in text


@pytest.mark.parametrize("type_name", JSON_STABLE)
@pytest.mark.parametrize("existing", (V4, V5))
def test_json_canonical_id_is_adopted_unchanged(
    tmp_path: Path, type_name: str, existing: str,
) -> None:
    path = _own_document(tmp_path, type_name, "report.json")
    path.write_text(json.dumps({"id": existing, "name": "R"}) + "\n", encoding="utf-8")
    before = path.read_bytes()
    info = _info(type_name)
    assert info.mint_entity_id(path) == existing
    assert info.mint_entity_id(path) == existing
    assert path.read_bytes() == before


@pytest.mark.parametrize("type_name", JSON_STABLE)
def test_missing_json_id_mints_exact_path_v5_and_persists(
    tmp_path: Path, type_name: str,
) -> None:
    path = _own_document(tmp_path, type_name, "report.json")
    path.write_text('{"name": "R"}\n', encoding="utf-8")
    expected = str(uuid.uuid5(uuid.NAMESPACE_URL, str(path.resolve())))
    info = _info(type_name)
    assert info.mint_entity_id(path) == expected
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
    if type_name == "data_source_spec":
        folder = root / "rss"
        folder.mkdir()
        (folder / "data_source.json").write_text(json.dumps({"schema": 1, "name": "rss"}), encoding="utf-8")
        return FSRef(folder), "data_source_spec:rss", namespace
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
        # Identity is (project_id, env_var) — NOT the locator. The declaration
        # must keep its id when its provider changes, which is what lets a value
        # move between stores.
        project_id = "3f2504e0-4f89-41d3-9a0c-0305e82c3301"
        path.write_text(
            json.dumps(
                {
                    "data": {
                        "project_id": project_id,
                        "env_var": "DEMO_TOKEN",
                        "locator": {"kind": "local", "sod_name": "demo"},
                    }
                }
            )
        )
        return FSRef(path), f"secret-origin:{project_id}:DEMO_TOKEN", namespace
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
    "data_source_spec", "dynamic_workflow", "markdown_index", "mcp_server",
    "plugin", "project", "secret_origin", "spreadsheet", "todo_file",
    "workflow_run",
)


@pytest.mark.parametrize("type_name", DETERMINISTIC_TYPES)
def test_deterministic_provider_exact_v5_matrix(tmp_path: Path, type_name: str) -> None:
    ref, stable_key, namespace = _deterministic_case(tmp_path, type_name)
    info = _info(type_name)
    assert info.read_id(ref) is None
    assert info.stable_key_for(ref) == stable_key
    assert info.mint_entity_id(ref) == str(uuid.uuid5(namespace, stable_key))


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
    assert _info(type_name).mint_entity_id(ref) == V4


# ── Shipped assets survive an install relocation ──────────────────────────────
#
# A REPO asset that ships inside the wheel lives under `site-packages`, so its
# absolute path is a property of the INSTALL, not of the asset: it differs
# between a uv tool dir, a plain python prefix and uv's own cache archive — all
# three of which coexist on one machine — and it changes on every upgrade.
# `mint_entity_id` falls back to `uuid5(resolved path)` for a derived-identity
# type that declares no stable key, so each install location mints a SEPARATE
# row for the same shipped asset and the Data Sources picker renders one button
# per row.

#: Derived-identity types whose assets SHIP with the SDK, so their absolute path
#: is the install's and never the asset's.
#:
#: `micro_app` still fails: it has the same missing-key defect, but `name` is not
#: its natural key — every shipped source nests an editor at
#: `data_source/<name>/agentic-assets/webapp/editor`, so nine of them are called
#: `editor` and keying on the bare name would collapse nine assets into one. It
#: needs a key that carries its owner (e.g. `<owner>/<app>`), which is a separate
#: change from FLOWPAD-2070; xfail keeps the defect visible until then.
SHIPPED_RELOCATABLE_TYPES = (
    "credential_spec", "data_source_spec",
    pytest.param("micro_app", marks=pytest.mark.xfail(strict=True, reason="needs an owner-scoped key; nine assets are named 'editor'")),
)

_SHIPPED_MANIFEST = {
    "credential_spec": (
        "credential",
        "credential.json",
        {"schema": 1, "name": "gmail", "title": "Gmail", "vars": {"GMAIL_ADDRESS": {}}},
    ),
    "data_source_spec": ("data_source", "data_source.json", {"schema": 1, "name": "rss", "title": "RSS / Atom"}),
    "micro_app": ("webapp", "webapp.json", {"schema": 1, "name": "editor", "title": "Editor"}),
}


def _shipped_asset(install_root: Path, type_name: str) -> FSRef:
    """The SAME authored asset, materialized under one install root.

    Mirrors the on-disk shape the walker finds:
    ``<install>/flow_sdk/system_projects/flowpad_assistant/agentic-assets/<family>/<name>/``.
    """
    family, main_file, manifest = _SHIPPED_MANIFEST[type_name]
    folder = (
        install_root / "Lib" / "site-packages" / "flow_sdk" / "system_projects"
        / "flowpad_assistant" / "agentic-assets" / family / manifest["name"]
    )
    folder.mkdir(parents=True)
    (folder / main_file).write_text(json.dumps(manifest), encoding="utf-8")
    return FSRef(folder, scope="system")


@pytest.mark.parametrize("type_name", SHIPPED_RELOCATABLE_TYPES)
def test_shipped_asset_keeps_one_id_across_install_locations(
    tmp_path: Path, type_name: str,
) -> None:
    """One shipped asset is one entity, wherever the wheel was unpacked.

    Reinstalling/upgrading relocates `site-packages`; the three roots below are
    the shape actually observed on a dev box (uv tool dir, python prefix, uv
    cache archive). A path-keyed id turns one source into three, which the
    picker renders as three identical providers.
    """
    info = _info(type_name)
    refs = [
        _shipped_asset(tmp_path / install, type_name)
        for install in ("uv-tools-flowpad", "pythoncore-3.14-64", "uv-cache-archive-v0")
    ]
    assert [info.read_id(ref) for ref in refs] == [None] * len(refs), "no carrier — identity is derived"

    ids = {info.mint_entity_id(ref) for ref in refs}
    assert len(ids) == 1, (
        f"{type_name}: the same shipped asset minted {len(ids)} ids across install "
        f"locations, so an upgrade forks it into {len(ids)} rows — {sorted(ids)}"
    )


@pytest.mark.parametrize("type_name", SHIPPED_RELOCATABLE_TYPES)
def test_shipped_asset_declares_an_install_independent_key(
    tmp_path: Path, type_name: str,
) -> None:
    """The mechanism behind the test above: with no stable key, `mint_entity_id`
    falls through to `uuid5(NAMESPACE_URL, resolved path)`."""
    info = _info(type_name)
    ref = _shipped_asset(tmp_path / "uv-tools-flowpad", type_name)
    stable_key = info.stable_key_for(ref)
    assert stable_key is not None, (
        f"{type_name} declares neither id_stable_key_fn nor identity_key_fn, so its id "
        f"is uuid5 of the absolute install path"
    )
    assert str(Path(getattr(ref, "_path", ref)).resolve()) not in stable_key, (
        f"{type_name}: the stable key still embeds the install path — {stable_key!r}"
    )
