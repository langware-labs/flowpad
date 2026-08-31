from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
from pydantic import ValidationError

from flow_sdk.assets.git_origin import PortableGitOrigin
from flow_sdk.assets.projection import layout_for_origin, project_asset_tree
from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.fs_store.schema_registry import SchemaRegistry


def _git(path: Path, *args: str) -> str:
    result = subprocess.run(["git", *args], cwd=path, capture_output=True, text=True, check=True)
    return result.stdout.strip()


def _origin(rel_path: str, *, head: str = "a" * 40) -> PortableGitOrigin:
    return PortableGitOrigin(
        provider="github",
        owner="flowpad",
        name="assets",
        branch="main",
        head_commit=head,
        rel_path=rel_path,
    )


def test_portable_origin_is_strict_and_keeps_legacy_key() -> None:
    origin = _origin("docs/q.md")
    assert origin.clone_url() == "https://github.com/flowpad/assets.git"
    assert origin.key() == "87d26ad2-1b3c-5a54-b409-5aaf5c2759f8"

    with pytest.raises(ValidationError):
        PortableGitOrigin.model_validate({**origin.model_dump(), "token": "secret"})
    for bad in ("/tmp/q.md", "../q.md", "docs\\q.md", ".git/config", "docs/q.md?token=x"):
        with pytest.raises(ValidationError):
            _origin(bad)
    with pytest.raises(ValidationError):
        _origin("docs/q.md", head="A" * 40)


def test_layout_mapper_handles_file_and_both_folder_shapes() -> None:
    markdown = SchemaRegistry.get("markdown")
    agent = SchemaRegistry.get("agent")
    skill = SchemaRegistry.get("skill")
    assert markdown and agent and skill
    assert layout_for_origin(markdown, _origin("docs/q.md")).model_dump() == {
        "asset_rel_root": "docs",
        "main_ref": "q.md",
    }
    assert layout_for_origin(agent, _origin("agentic-assets/agent/q")).model_dump() == {
        "asset_rel_root": "agentic-assets/agent/q",
        "main_ref": "agent.md",
    }
    assert layout_for_origin(skill, _origin(".claude/skills/e2e-qa")).model_dump() == {
        "asset_rel_root": ".claude/skills/e2e-qa",
        "main_ref": "SKILL.md",
    }


def test_markdown_projection_is_db_free_and_drops_local_or_unknown_fields(tmp_path: Path) -> None:
    _git(tmp_path, "init", "-q")
    asset_id = mint_uuid()
    doc = tmp_path / "docs" / "q.md"
    doc.parent.mkdir()
    doc.write_text(
        f"---\nid: {asset_id}\ntitle: Q\ntoken: must-not-leak\nasset_ref: /Users/alice/private\n---\n\nQA manager\n",
        encoding="utf-8",
    )
    projection = project_asset_tree(
        entity_type="markdown",
        expected_id=asset_id,
        checkout_root=tmp_path,
        origin=_origin("docs/q.md"),
    )
    assert projection.id == asset_id
    assert projection.layout.main_ref == "q.md"
    assert projection.fields["title"] == "Q"
    assert "token" not in projection.fields
    assert "asset_ref" not in projection.fields
    assert "/Users/alice/private" not in str(projection.model_dump(mode="json"))


def test_projection_rejects_identity_mismatch_and_symlink_escape(tmp_path: Path) -> None:
    _git(tmp_path, "init", "-q")
    actual_id = mint_uuid()
    docs = tmp_path / "docs"
    docs.mkdir()
    (docs / "q.md").write_text(f"---\nid: {actual_id}\n---\nQ\n", encoding="utf-8")
    with pytest.raises(ValueError, match="identity"):
        project_asset_tree(
            entity_type="markdown",
            expected_id=mint_uuid(),
            checkout_root=tmp_path,
            origin=_origin("docs/q.md"),
        )

    outside = tmp_path.parent / f"outside-{mint_uuid()}.md"
    outside.write_text(f"---\nid: {actual_id}\n---\nQ\n", encoding="utf-8")
    (docs / "escape.md").symlink_to(outside)
    with pytest.raises(ValueError, match="escapes"):
        project_asset_tree(
            entity_type="markdown",
            expected_id=actual_id,
            checkout_root=tmp_path,
            origin=_origin("docs/escape.md"),
        )
