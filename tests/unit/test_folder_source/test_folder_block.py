"""``Folder.listen()`` — the object-shaped sibling of ``Inbox.listen()``.

Same contract: one yield per page, ``ack()`` commits an offset, a page handed out and never
acked comes back after a restart flagged, and a folder consumer starts from the beginning
because a search index has to see the tree once.
"""

from __future__ import annotations

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.blocks import Delivered, Folder, FolderChange, workflow
from flow_sdk.ingest.reflect import ReflectMode

from ._harness import DOC, write_doc

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


def _name() -> str:
    return f"w-{mint_uuid()}"


async def _take(folder: Folder, n: int) -> list[Delivered]:
    agen = folder.listen(poll_every=0)
    out: list[Delivered] = []
    try:
        while len(out) < n:
            out.append(await agen.__anext__())
    finally:
        await agen.aclose()
    return out


async def test_the_first_page_is_the_whole_tree(folder_db, watched, project, make_source):
    DOC.create(watched)
    await make_source(ReflectMode.NONE.value)          # the same source Folder() will find by root
    folder = Folder(str(watched))
    async with workflow(_name()):
        (change,) = await _take(folder, 1)
    assert isinstance(change, Delivered) and isinstance(change.item, FolderChange)
    assert change.added and change.added[0].endswith("a.md")
    assert change.root == str(watched)


async def test_an_unacked_page_is_redelivered_and_an_acked_one_is_not(folder_db, watched, project, make_source):
    DOC.create(watched)
    await make_source(ReflectMode.NONE.value)
    folder, name = Folder(str(watched)), _name()

    async with workflow(name):
        (first,) = await _take(folder, 1)             # died holding it
    async with workflow(name):
        (again,) = await _take(folder, 1)
        assert again.redelivered and again.added == first.added
        await again.ack()

    write_doc(watched, "a.md", "# a\n\nrevised\n")
    async with workflow(name):
        (edit,) = await _take(folder, 1)
    assert edit.changed and not edit.redelivered


async def test_reply_is_not_a_folder_verb(folder_db, watched, project, make_source):
    DOC.create(watched)
    await make_source(ReflectMode.NONE.value)
    (change,) = await _take(Folder(str(watched)), 1)
    from flow_sdk.builtin.source_item import EmailMessageSpec

    with pytest.raises(RuntimeError):
        await change.reply(EmailMessageSpec(to=["a@b"], body="x", thread_key="t"))


async def test_mirror_to_copies(folder_db, watched, project, in_workspace):
    DOC.create(watched)
    folder = Folder(str(watched), mirror_to=str(project))
    await folder.sync()
    assert (project / "a.md").exists()
