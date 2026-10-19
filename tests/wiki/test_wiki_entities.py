from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.claude_memory_entities import Docs
from flow_sdk.builtin.project import Project
from flow_sdk.builtin.skill import Skill
from flow_sdk.builtin.wiki import Wiki, WikiEntry
from flow_sdk.fs_store.record_paths import get_default_records_root, set_default_records_root
from flow_sdk.wiki.parser import canonicalize_word
from flow_sdk.wiki.service import (
    bind,
    default_wiki_id,
    ensure_default_wiki,
    resolve,
    unbind,
)

pytestmark = pytest.mark.asyncio


@pytest.fixture()
def records_root(tmp_path):
    original = get_default_records_root()
    set_default_records_root(tmp_path / "records")
    yield
    set_default_records_root(original)


async def _project(tmp_path: Path) -> Project:
    project = Project(
        id=mint_uuid(),
        uname=f"project-{mint_uuid()}",
        name="Wiki Project",
        fs_storage_mount_path=str(tmp_path),
    )
    await project.save()
    return project


async def _doc(project: Project, tmp_path: Path, name: str) -> Docs:
    ref = tmp_path / f"{name}-{mint_uuid()}.md"
    doc = Docs(
        id=mint_uuid(),
        name=name,
        uname=name,
        title=name,
        asset_ref=str(ref),
        project_id=str(project.id),
    )
    await doc.save()
    return doc


async def test_project_save_creates_one_stable_default_wiki(records_root, tmp_path):
    project = await _project(tmp_path)
    first = await ensure_default_wiki(project)
    second = await ensure_default_wiki(project)

    assert first.id == default_wiki_id(str(project.id))
    assert second.id == first.id
    assert first.uname == f"wiki-{project.id}"
    assert first.project_id == str(project.id)
    children = [getattr(child, "value", child) for child in await project.get_children()]
    assert [child.id for child in children].count(first.id) == 1
    assert await first.get_record() is None


async def test_bind_is_stable_and_unbind_is_idempotent(records_root, tmp_path):
    project = await _project(tmp_path)
    wiki = await ensure_default_wiki(project)
    doc = await _doc(project, tmp_path, "Bound")

    first = await bind(wiki, "./Bound.md#Heading|Alias", doc.typeid)
    second = await bind(wiki, "Bound", doc.typeid)
    assert first.id == second.id
    assert first.word == "Bound"
    assert isinstance(second, WikiEntry)

    assert await unbind(wiki, "Bound") is True
    assert await unbind(wiki, "Bound") is True
    assert (await resolve(wiki, "Bound"))["kind"] == "resolved"  # implicit again


async def test_explicit_entry_wins_and_dangling_entry_blocks_fallback(records_root, tmp_path):
    project = await _project(tmp_path)
    wiki = await ensure_default_wiki(project)
    implicit = await _doc(project, tmp_path, "Guide")
    explicit = await _doc(project, tmp_path, "Other")

    await bind(wiki, "Guide", explicit.typeid)
    result = await resolve(wiki, "Guide")
    assert result == {
        "kind": "resolved",
        "target_typeid": str(explicit.typeid),
        "source": "entry",
    }

    await explicit.delete()
    assert await resolve(wiki, "Guide") == {"kind": "missing"}
    assert await Docs.get_by_id(implicit.id) is not None


async def test_implicit_missing_unique_and_ambiguous(records_root, tmp_path):
    project = await _project(tmp_path)
    wiki = await ensure_default_wiki(project)
    doc = await _doc(project, tmp_path, "Setup")

    assert await resolve(wiki, "Missing") == {"kind": "missing"}
    assert await resolve(wiki, "Setup") == {
        "kind": "resolved",
        "target_typeid": str(doc.typeid),
        "source": "implicit",
    }

    folder = tmp_path / "skill"
    folder.mkdir()
    skill = Skill(
        id=mint_uuid(),
        name="Setup",
        uname="Setup",
        asset_ref=str(folder),
        project_id=str(project.id),
    )
    await skill.save()
    assert await resolve(wiki, "Setup") == {"kind": "ambiguous"}


async def test_named_wiki_has_no_implicit_fallback(records_root, tmp_path):
    project = await _project(tmp_path)
    await _doc(project, tmp_path, "OnlyDefault")
    named = Wiki(
        id=mint_uuid(),
        uname=f"wiki-{mint_uuid()}",
        name="Curated",
        project_id=str(project.id),
        parent_type_id=str(project.typeid),
    )
    await project.add_child(named)
    assert await resolve(named, "OnlyDefault") == {"kind": "missing"}


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (" Word ", "Word"),
        ("Word|Alias", "Word"),
        ("Word#Heading", "Word"),
        ("Word^block", "Word"),
        ("./Word.md", "Word"),
        ("Folder/child.md", "Folder"),
    ],
)
async def test_word_normalization_preserves_existing_behavior(raw, expected):
    assert canonicalize_word(raw) == expected
