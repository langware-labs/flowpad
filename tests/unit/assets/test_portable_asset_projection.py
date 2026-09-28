from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.assets.projection import layout_for_origin, read_asset_tree
from flow_sdk.builtin.asset_projection import project_asset_tree
from flow_sdk.fs_store.origin.hub_repo_origin import HubRepoOrigin
from flow_sdk.fs_store.schema_registry import SchemaRegistry


def _git(path: Path, *args: str) -> str:
    result = subprocess.run(["git", *args], cwd=path, capture_output=True, text=True, check=True)
    return result.stdout.strip()


@dataclass(frozen=True)
class _Placement:
    """All a projection reads of an origin — the hub passes an object with only this."""

    rel_path: str


def _origin(rel_path: str) -> _Placement:
    return _Placement(rel_path=rel_path)


def test_hosted_repo_origin_satisfies_the_placement_contract(tmp_path: Path) -> None:
    """The desk's own ``HubRepoOrigin`` projects exactly like a bare placement."""
    markdown = SchemaRegistry.get("markdown")
    assert markdown
    hosted = HubRepoOrigin(repo="git_repo-" + "1" * 32, rel_path="docs/q.md", head_commit="a" * 40, tree="b" * 40)
    assert layout_for_origin(markdown, hosted) == layout_for_origin(markdown, _origin("docs/q.md"))


def test_reader_refuses_a_placement_that_leaves_the_checkout_or_enters_git(tmp_path: Path) -> None:
    _git(tmp_path, "init", "-q")
    asset_id = mint_uuid()
    (tmp_path / "q.md").write_text(f"---\nid: {asset_id}\n---\nQ\n", encoding="utf-8")
    for bad in ("/tmp/q.md", "../q.md", "docs\\q.md", ".git/config", ""):
        with pytest.raises(ValueError, match="checkout-relative"):
            read_asset_tree(entity_type="markdown", expected_id=asset_id, checkout_root=tmp_path, origin=_origin(bad))


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
        "main_ref": "agent.json",
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


def test_filesystem_reader_needs_no_entity_resolution_and_does_not_write(tmp_path: Path, monkeypatch) -> None:
    _git(tmp_path, "init", "-q")
    asset_id = mint_uuid()
    doc = tmp_path / "q.md"
    content = f"---\nid: {asset_id}\ntitle: Q\n---\n\nQA manager\n"
    doc.write_text(content, encoding="utf-8")
    before = doc.stat().st_mtime_ns

    def forbidden_entity_resolution(*args, **kwargs):
        raise AssertionError("filesystem reading must not resolve an Entity model")

    monkeypatch.setattr(SchemaRegistry, "get_entity_cls", forbidden_entity_resolution)
    record = read_asset_tree(
        entity_type="markdown", expected_id=asset_id, checkout_root=tmp_path, origin=_origin("q.md")
    )
    assert str(record.id) == asset_id
    assert str(record.type) == "markdown"
    assert doc.read_text(encoding="utf-8") == content
    assert doc.stat().st_mtime_ns == before


def test_projection_rejects_identity_mismatch_and_symlink_escape(tmp_path: Path) -> None:
    _git(tmp_path, "init", "-q")
    actual_id = mint_uuid()
    docs = tmp_path / "docs"
    docs.mkdir()
    (docs / "q.md").write_text(f"---\nid: {actual_id}\n---\nQ\n", encoding="utf-8")
    with pytest.raises(ValueError, match="identity"):
        read_asset_tree(
            entity_type="markdown",
            expected_id=mint_uuid(),
            checkout_root=tmp_path,
            origin=_origin("docs/q.md"),
        )

    outside = tmp_path.parent / f"outside-{mint_uuid()}.md"
    outside.write_text(f"---\nid: {actual_id}\n---\nQ\n", encoding="utf-8")
    (docs / "escape.md").symlink_to(outside)
    with pytest.raises(ValueError, match="escapes"):
        read_asset_tree(
            entity_type="markdown",
            expected_id=actual_id,
            checkout_root=tmp_path,
            origin=_origin("docs/escape.md"),
        )
