"""CRUD on a FOLDER-layout asset (a skill) reaching the graph through a source.

A skill's asset root is a DIRECTORY whose ``main_file`` is ``SKILL.md``, where a
doc's root is the file itself. The folder driver deliberately emits leaf files
either way and lets ``reindex_paths`` resolve containment, so this module is
where that delegation is either vindicated or shown to have a hole.
"""
from __future__ import annotations

import pytest

from flow_sdk.ingest.reflect import ReflectMode

from ._harness import entity_at, id_at, poll, write_skill

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


async def test_skill_folder_is_recognised(folder_db, watched, make_source):
    """A skill folder appearing in a watched tree becomes a SKILL.

    ``reindex_paths`` used to mint by EXTENSION only (``.md`` → ``markdown``),
    so ``SKILL.md`` became a plain document and the folder-layout type was never
    considered — the incremental path could not mint a folder asset at all.
    It now asks the registry's own classifier (``TypeInfo.layout_of``), which
    recognises the fixed ``main_file`` and names the FOLDER as the asset root.
    """
    folder = write_skill(watched)
    source, _project = await make_source(ReflectMode.NONE.value)

    await poll(source)

    ent = await entity_at(folder / "SKILL.md")
    assert ent is not None, "nothing indexed at all"
    assert ent.type == "skill", f"folder-layout asset minted as {ent.type!r}"
    assert str(ent.asset_ref) == str(folder), "asset_ref must name the FOLDER, not the inner file"


async def test_file_added_inside_a_known_folder_asset_resolves_to_it(
    folder_db, watched, make_source
):
    """Containment resolution is the whole reason the driver emits leaves.

    The changed loop uses ``resolve_containing=True``, so a file written inside
    an asset root resolves to the asset that owns it rather than minting a
    sibling. If this regresses, every folder-layout asset silently fragments
    into one entity per file.
    """
    folder = write_skill(watched)
    source, _project = await make_source(ReflectMode.NONE.value)
    await poll(source)
    owner = await id_at(folder / "SKILL.md")
    assert owner is not None

    (folder / "reference.md").write_text("# Reference\n\nextra material\n", encoding="utf-8")
    await poll(source)

    # Containment only has something to resolve TO once the folder asset is
    # typed correctly and its asset_ref names the folder; while SKILL.md minted
    # as a markdown-of-the-file, every sibling fragmented into its own entity.
    sibling = await id_at(folder / "reference.md")
    assert sibling is not None
    assert sibling == owner, "sibling minted its own entity instead of resolving to the asset root"


async def test_deleting_an_inner_file_does_not_destroy_the_asset(
    folder_db, watched, make_source
):
    """The removed loop is exact-match (``resolve_containing=False``).

    That asymmetry is deliberate and load-bearing: deleting one file inside a
    folder asset must not reap the asset. Pinning it here means a well-meaning
    change to make the two loops symmetric fails loudly instead of quietly
    deleting people's skills.
    """
    folder = write_skill(watched)
    extra = folder / "reference.md"
    extra.write_text("# Reference\n", encoding="utf-8")
    source, _project = await make_source(ReflectMode.NONE.value)
    await poll(source)
    owner = await id_at(folder / "SKILL.md")
    assert owner is not None

    extra.unlink()
    await poll(source)

    assert await id_at(folder / "SKILL.md") == owner, "deleting an inner file reaped the asset"
