from __future__ import annotations

from pathlib import Path

import pytest

import flow_sdk.fs_store.asset_occurrences as occurrence_module
import flow_sdk.fs_store.indexer.registrations  # noqa: F401
from flow_sdk.builtin.faas.scan_indexer import _project_nodes
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.schema.types import EntityType


@pytest.mark.asyncio
async def test_projection_uses_primary_and_exposes_all_occurrences(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    asset_id = "687e6011-3912-4933-817d-787b735ef917"
    a = tmp_path / "a.md"
    b = tmp_path / "b.md"
    body = f"---\nid: {asset_id}\n---\n# duplicate\n"
    a.write_text(body, encoding="utf-8")
    b.write_text(body, encoding="utf-8")
    monkeypatch.setattr(
        occurrence_module, "_trusted_birth_time", lambda _path: None,
    )

    items = await _project_nodes(
        [
            FSRef(b, record_type=RecordType.MARKDOWN),
            FSRef(a, record_type=RecordType.MARKDOWN),
        ],
        EntityType.MARKDOWN,
        "markdown",
        "system_resource_claude_markdown",
    )

    assert len(items) == 1
    assert items[0]["id"] == asset_id
    assert items[0]["duplicate_count"] == 1
    assert [item["path"] for item in items[0]["asset_occurrences"]] == [
        str(a.resolve()),
        str(b.resolve()),
    ]
