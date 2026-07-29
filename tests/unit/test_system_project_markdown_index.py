from __future__ import annotations

from types import SimpleNamespace

import pytest

from flow_sdk.core.entity import Entity
from flow_sdk.fs_store.indexer.functions import markdown as markdown_index
from flow_sdk.server.routes.bootstrap import _index_system_project_markdowns


@pytest.mark.asyncio
async def test_system_project_markdown_seed_populates_fts(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    docs = tmp_path / "docs"
    docs.mkdir()
    (docs / "hello.md").write_text(
        "---\n"
        "id: dc8713d4-8841-47ab-a28d-8e3248106f5a\n"
        "title: Hello from Flowpad\n"
        "---\n\n"
        "# Hello from Flowpad\n\n"
        "A shipped assistant document.\n",
        encoding="utf-8",
    )
    project = SimpleNamespace(
        id="8ba207d9-636a-4589-bf21-a191065f8c3c",
        fs_storage_mount_path=str(tmp_path),
    )
    upserts: list[tuple[str, str]] = []
    extract_markdown = markdown_index.extract_markdown

    def extract_with_stale_project(*args, **kwargs):
        records = extract_markdown(*args, **kwargs)
        assert records
        object.__setattr__(
            records[0],
            "project_id",
            "71ef101f-edeb-4180-a240-0360ab659369",
        )
        return records

    class SeededEntity:
        async def _fts_upsert(self, type_name: str, content: str) -> None:
            upserts.append((type_name, content))

    async def from_record(_cls, record, notify: bool = True):
        assert notify is False
        assert record.project_id == project.id
        assert record.system is True
        return SeededEntity()

    monkeypatch.setattr(markdown_index, "extract_markdown", extract_with_stale_project)
    monkeypatch.setattr(Entity, "from_record", classmethod(from_record))

    await _index_system_project_markdowns([project])

    assert len(upserts) == 1
    assert upserts[0][0] == "markdown"
    assert "A shipped assistant document." in upserts[0][1]
