"""Unit tests for the lazy legacy-include_dirs → Folder-links migration.

Old projects stored context folders in a real ``include_dirs`` field (DB rows
and metadata.json both carry the key). The field is now computed; the raw key
is stashed by a before-validator and converted into private Folder context
links at the next write. Contract:

  * hydration with a raw ``include_dirs`` → stash captured, computed property
    merges it immediately (workers/UI see the dirs), NO write happens on read;
  * the first write (action or plain save) mints Folders + private links and
    clears the stash; a second save is a no-op;
  * the stale on-disk ``include_dirs`` key is neutralized (merge-writer would
    otherwise resurrect removed dirs after a DB rebuild);
  * ``Project(**model_dump())`` (computed key fed back in) is harmless.
"""
import json

import pytest

from flow_sdk.builtin.folder import Folder
from flow_sdk.builtin.project import Project
from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.path_utils import canonical_posix_path
from flow_sdk.schema.type_info import register_all

register_all()


def _dirs(tmp_path, *names):
    out = []
    for n in names:
        d = tmp_path / n
        d.mkdir(exist_ok=True)
        out.append(canonical_posix_path(str(d)))
    return out


@pytest.mark.asyncio
async def test_stash_and_readthrough_without_write(tmp_path):
    legacy = _dirs(tmp_path, "a", "b")
    project = Project(name=str(tmp_path / "proj"), include_dirs=list(legacy))

    # Raw key captured; computed merge exposes it pre-migration.
    assert project.legacy_include_dirs_ == legacy
    assert project.include_dirs == legacy
    # Reading did NOT mint any Folder entity (no write on read paths).
    for p in legacy:
        assert await Folder.get_by_id(Folder.id_for_path(p)) is None


@pytest.mark.asyncio
async def test_first_save_converges(tmp_path):
    legacy = _dirs(tmp_path, "a", "b")
    project = Project(name=str(tmp_path / "proj"), include_dirs=list(legacy))
    await project.save()

    # Folders minted + linked privately; stash cleared; list unchanged.
    assert project.legacy_include_dirs_ == []
    assert sorted(project.include_dirs) == sorted(legacy)
    tids = project.context_of_type("folder", bucket="private")
    assert len(tids) == 2
    for p in legacy:
        assert await Folder.get_by_id(Folder.id_for_path(p)) is not None

    # Second save is a stable no-op.
    before = [str(t) for t in project.context_of_type("folder", bucket="both")]
    await project.save()
    assert [str(t) for t in project.context_of_type("folder", bucket="both")] == before


@pytest.mark.asyncio
async def test_action_migrates_then_applies(tmp_path):
    legacy = _dirs(tmp_path, "old")
    (extra,) = _dirs(tmp_path, "new")
    project = Project(name=str(tmp_path / "proj"), include_dirs=list(legacy))

    await project.add_context_dir(extra)
    assert sorted(project.include_dirs) == sorted(legacy + [extra])
    assert project.legacy_include_dirs_ == []
    assert len(project.context_of_type("folder", bucket="private")) == 2

    # Removing a LEGACY dir works post-migration (link exists to remove) and
    # it must not resurrect on a metadata re-adopt.
    await project.remove_context_dir(legacy[0])
    assert project.include_dirs == [extra]

    record = FSRecord.load(project.get_type(), project.id)
    meta = record.meta_dict()
    # Stale disk key neutralized: either gone or an empty list.
    assert not meta.get("include_dirs")
    rehydrated = await Project.from_record(record, notify=False)
    assert rehydrated.include_dirs == [extra]


@pytest.mark.asyncio
async def test_model_dump_feedback_is_harmless(tmp_path):
    (ctx,) = _dirs(tmp_path, "ctx")
    project = Project(name=str(tmp_path / "proj"))
    await project.save()
    await project.add_context_dir(ctx)

    dump = project.model_dump(mode="json")
    assert dump["include_dirs"] == [ctx]
    clone = Project(**dump)
    # The computed output re-entered as a raw key → stashed; computed view is
    # identical (dedup against the folder link), and a save converges to the
    # same link set without duplicates.
    assert clone.include_dirs == [ctx]
    await clone.save()
    assert clone.legacy_include_dirs_ == []
    assert len(clone.context_of_type("folder", bucket="both")) == 1
    assert json.loads(json.dumps(clone.include_dirs)) == [ctx]
