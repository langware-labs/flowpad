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

import httpx
import pytest

from flow_sdk.builtin.conversation import Conversation
from flow_sdk.cloud_client.hub_proxy import HubProxy
from flow_sdk.cloud_client.shared.errors import HubError
from flow_sdk.core.entity.entity_model import Entity


class _FakeResponse:
    def __init__(self, status_code: int, text: str):
        self.status_code = status_code
        self.text = text

    def json(self):
        import json

        return json.loads(self.text)


_OK = '{"status":"success","data":{}}'
_CONFLICT = '{"detail":"A conflicting record already exists"}'
_HIDDEN = '{"status":"FAIL","message":"Missing request info(Target entity not found)","data":{"error_code":"target_not_found"}}'


@pytest.fixture()
def hub_response(monkeypatch):
    """Stub the hub client's single network method so ``Entity.share`` runs
    fully offline, answering per HTTP method: ``post`` is the create, ``get``
    the ownership probe a 409 makes."""
    holder = {"post": _FakeResponse(200, _OK), "get": _FakeResponse(200, _OK)}

    async def fake_send(method, url, **kwargs):
        r = holder[method.lower()]
        return httpx.Response(
            r.status_code, text=r.text, headers={"content-type": "application/json"}, request=httpx.Request(method, str(url))
        )

    monkeypatch.setattr(
        "flow_sdk.cli.auth.credentials.load_credentials",
        lambda: SimpleNamespace(api_key="test-key", user={"id": "alice"}, is_expired=lambda *_a: False),
    )
    monkeypatch.setattr("flow_sdk.cloud_client.client.ApiConfig.from_env", staticmethod(lambda: None))
    monkeypatch.setattr(HubProxy, "send", staticmethod(fake_send))
    return holder


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
@pytest.mark.parametrize(
    "post, get, raises",
    [
        ((200, _OK), (200, _OK), None),  # clean create
        ((409, _CONFLICT), (200, _OK), None),  # the row is ours: idempotent re-share
        ((409, _CONFLICT), (403, _HIDDEN), "id_taken"),  # someone else's row: never remote
        ((409, _CONFLICT), (503, '{"detail":"down"}'), "503"),  # an outage stays an outage
        ((500, '{"detail":"boom"}'), (200, _OK), "500"),
    ],
)
async def test_share_sets_remote_only_for_a_row_this_account_reaches(hub_response, post, get, raises):
    """``remote=True`` means the hub holds this id FOR US. A 409 alone proves only that
    some row holds it — the hub answers 409 whoever owns it — so share probes it."""
    hub_response["post"], hub_response["get"] = _FakeResponse(*post), _FakeResponse(*get)
    conv = Conversation(title="share-probe")

    if raises:
        with pytest.raises(HubError) as err:
            await Entity.share(conv)
        assert raises in (err.value.code or "") or raises in str(err.value)
        assert conv.remote is not True
    else:
        assert await Entity.share(conv) is conv
        assert conv.remote is True
