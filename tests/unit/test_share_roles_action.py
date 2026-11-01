"""``GET /api/v1/graph/share-roles`` — the global list of roles a share invite may grant."""
from __future__ import annotations

import pytest

from flow_sdk.app.actions.share_action import share_roles

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


@pytest.mark.asyncio
async def test_share_roles_is_canonical_assignable_set():
    assert (await share_roles()).data == ["admin", "editor", "reader", "runner"]
