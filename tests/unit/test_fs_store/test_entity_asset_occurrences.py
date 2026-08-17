from __future__ import annotations

from datetime import datetime, timezone

import pytest

from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.fs_store.asset_occurrences import AssetOccurrence

OCCURRENCES = [
    AssetOccurrence("/assets/primary.md", datetime(2026, 1, 1, tzinfo=timezone.utc)),
    AssetOccurrence("/assets/copy.md", datetime(2026, 1, 2, tzinfo=timezone.utc)),
]


def test_occurrences_are_local_only_and_duplicate_count_is_computed() -> None:
    entity = Entity(
        type="markdown",
        asset_occurrences=[
            {"path": item.path, "first_seen_at": item.first_seen_at.isoformat()}
            for item in OCCURRENCES
        ],
    )

    assert entity.duplicate_count == 1
    assert "asset_occurrences" not in entity.metadata_payload()
    assert "asset_occurrences" not in entity.to_common_json()
    assert "duplicate_count" not in entity.to_common_json()
    assert "asset_occurrences" not in entity._hub_body()
    assert "duplicate_count" not in entity._hub_body()
    assert "asset_occurrences" in Entity.fields_not_accepted_from_hub()


@pytest.mark.asyncio
async def test_reflection_is_db_only_idempotent_and_optionally_notifies(
    sync_db, monkeypatch: pytest.MonkeyPatch
) -> None:
    entity = Entity(type="markdown")
    notifications = 0

    async def notified(_self) -> None:
        nonlocal notifications
        notifications += 1

    monkeypatch.setattr(Entity, "notify_updated", notified)
    assert await entity.reflect_asset_occurrences(OCCURRENCES, notify=True) is True
    assert notifications == 1
    assert await entity.reflect_asset_occurrences(OCCURRENCES, notify=True) is False
    assert notifications == 1

    loaded = await sync_db.get_by_id(entity.id, "markdown")
    assert loaded is not None
    assert loaded.asset_occurrences == [
        {"path": item.path, "first_seen_at": item.first_seen_at.isoformat()}
        for item in OCCURRENCES
    ]
    assert loaded.duplicate_count == 1
