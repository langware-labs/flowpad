"""Generic Entity edit-recency action regressions."""

from __future__ import annotations

import pytest

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.core.entity.entity_model import Entity, _http_mark_edit


class _EditMarkProbe(Entity):
    type: str = APIField(default="edit_mark_probe")
    revision: int = APIField(default=0)


@pytest.mark.asyncio
async def test_mark_edit_atomically_preserves_newer_state_and_notifies() -> None:
    from flow_sdk.actions import action

    registered = action.get_by_name("mark-edit", _EditMarkProbe.get_type())
    assert registered is not None and registered.handler is _http_mark_edit

    probe = _EditMarkProbe(id=mint_uuid(), revision=0)
    await probe.save()
    stale = await _EditMarkProbe.get_one({"id": probe.id})
    newer = await _EditMarkProbe.get_one({"id": probe.id})
    assert stale is not None and newer is not None

    newer.revision = 1
    await newer.save()
    before = await _EditMarkProbe.get_one({"id": probe.id})
    assert before is not None
    before_updated_date = before.updated_date

    stale.revision = -1
    assert stale.dirty is True
    notifications = []
    stale.observe(notifications.append)

    response = await _http_mark_edit(stale)

    persisted = await _EditMarkProbe.get_one({"id": probe.id})
    assert persisted is not None
    assert persisted.revision == 1
    assert persisted.updated_date == before_updated_date
    assert persisted.last_edited_at == response.data["last_edited_at"]
    assert isinstance(persisted.last_edited_at, int)
    assert stale.revision == -1 and stale.dirty is True
    assert stale.last_edited_at == persisted.last_edited_at
    assert len(notifications) == 1
    assert notifications[0].data.revision == 1
    assert notifications[0].data.last_edited_at == persisted.last_edited_at


@pytest.mark.asyncio
async def test_mark_edit_deleted_snapshot_returns_404_without_notification() -> None:
    probe = _EditMarkProbe(id=mint_uuid())
    await probe.save()
    stale = await _EditMarkProbe.get_one({"id": probe.id})
    assert stale is not None
    notifications = []
    stale.observe(notifications.append)
    await probe.delete()

    response = await _http_mark_edit(stale)

    assert response.status == "FAIL"
    assert response.status_code == 404
    assert notifications == []
    assert await _EditMarkProbe.get_one({"id": probe.id}) is None
