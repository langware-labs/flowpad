"""``Entity.share`` must treat a hub 409 ("already exist") as an idempotent
no-op success — re-sharing an already-shared entity (e.g. inviting a second
member to a conversation via ``Conversation.share`` → ``super().share()``)
must NOT surface as a 500.

The tolerance lives in ``FlowpadClient.post(idempotent=True)``; these tests
exercise the real ``post`` / ``_unwrap`` path with only the single network hop
(``FlowpadClient.request``) stubbed, so credentials/config/env aren't needed.

Regression for the production ``POST /graph/conversation/<id>/share`` 500:
``Internal server error: API returned status 409: Save error(already exist)``.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from flow_sdk.builtin.conversation import Conversation
from flow_sdk.core.entity.entity_model import Entity


class _FakeResponse:
    def __init__(self, status_code: int, text: str):
        self.status_code = status_code
        self.text = text

    def json(self):
        import json

        return json.loads(self.text)


@pytest.fixture()
def hub_response(monkeypatch):
    """Stub the hub client's single network method so ``Entity.share`` runs
    fully offline. Mutate ``holder['resp']`` per test to pick the hub's reply."""
    holder = {"resp": _FakeResponse(200, '{"status":"success","data":{}}')}

    async def fake_request(self, method, path, **kwargs):
        return holder["resp"]

    monkeypatch.setattr(
        "flow_sdk.cli.auth.credentials.load_credentials",
        lambda: SimpleNamespace(api_key="test-key", user={"id": "alice"}),
    )
    monkeypatch.setattr("flow_sdk.cloud_client.client.ApiConfig.from_env", staticmethod(lambda: None))
    monkeypatch.setattr("flow_sdk.cloud_client.client.FlowpadClient.request", fake_request)
    return holder


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
@pytest.mark.parametrize(
    "status, text, expect_raise",
    [
        (200, '{"status":"success","data":{}}', False),
        (409, '{"detail":"Save error(already exist) - Conversation: id = x"}', False),
        (500, '{"detail":"boom"}', True),
    ],
)
async def test_share_idempotent_on_409(hub_response, status, text, expect_raise):
    """200 and 409 both succeed (and flip ``remote=True``); any other non-200
    is a real failure that still raises."""
    hub_response["resp"] = _FakeResponse(status, text)
    conv = Conversation(title=f"share-{status}")

    if expect_raise:
        with pytest.raises(ValueError, match=str(status)):
            await Entity.share(conv)
    else:
        assert await Entity.share(conv) is conv
        assert conv.remote is True  # 409 still means "this entity is on the hub"
