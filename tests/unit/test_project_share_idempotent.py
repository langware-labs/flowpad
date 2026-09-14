"""``Project.share`` must treat a hub 409 as an idempotent no-op, like the
``Entity.share`` it overrides.

``Project.share`` is a full override — it does not call ``super().share()`` —
and it was posting WITHOUT ``idempotent=True``, so the tolerance proven in
``test_entity_share_idempotent.py`` did not reach it. The result was an
unrecoverable state: the hub keeps a row at this id, the create 409s, the
``remote = True`` on the next line never runs, the local row never learns it is
published, and the only remediation the UI offers ("Link to cloud") is the same
POST that just failed. Deploy stays refused by ``_publish_service``'s
``project.remote is not True`` gate with no way out from inside the app.

A 409 is only adopted once a GET confirms this account can reach the row —
a Project id lives in the folder's ``.flow/id``, so a cloned repo carries the
original author's id and must NOT be silently adopted.

Same shape as its sibling: only the single network hop
(``FlowpadClient.request``) is stubbed, so the real ``post`` / ``get`` /
``_unwrap`` path runs and no credentials, config or env are needed.

Regression for FLOWPAD-2124.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from flow_sdk.builtin.project import Project


class _FakeResponse:
    def __init__(self, status_code: int, text: str):
        self.status_code = status_code
        self.text = text

    def json(self):
        import json

        return json.loads(self.text)


_OK = '{"status":"success","data":{}}'
_CONFLICT = '{"detail":"A conflicting record already exists"}'
_HIDDEN = '{"detail":"target not found"}'


@pytest.fixture()
def hub(monkeypatch):
    """Stub the hub client's one network method, answering per HTTP method.

    ``post`` is the create; ``get`` is the ownership probe the 409 branch makes.
    Tests set ``hub['post']`` / ``hub['get']`` and read ``hub['calls']``.
    """
    holder = {
        "post": _FakeResponse(200, _OK),
        "get": _FakeResponse(200, _OK),
        "calls": [],
    }

    async def fake_request(self, method, path, **kwargs):
        holder["calls"].append((method, path))
        return holder[method.lower()]

    monkeypatch.setattr(
        "flow_sdk.cli.auth.credentials.load_credentials",
        lambda: SimpleNamespace(api_key="test-key", user={"id": "alice"}),
    )
    monkeypatch.setattr("flow_sdk.cloud_client.client.ApiConfig.from_env", staticmethod(lambda: None))
    monkeypatch.setattr("flow_sdk.cloud_client.client.FlowpadClient.request", fake_request)
    return holder


def _project() -> Project:
    """A project with no mount, so ``share`` touches no git and no filesystem."""
    return Project(name="share-idempotent")


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_share_succeeds_on_clean_create(hub):
    """The ordinary path is unchanged: 200 publishes and needs no ownership probe."""
    proj = _project()

    assert await proj.share() is proj
    assert proj.remote is True
    assert proj.hub_published_at, "a successful publish stamps the publication marker"
    assert [m for m, _ in hub["calls"]] == ["POST"], "a clean create must not probe"


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_share_adopts_a_409_row_this_account_can_reach(hub):
    """THE BUG: the hub already holds our row, so publishing is already done.

    Before the fix this raised ``ValueError: API returned status 409`` and left
    ``remote`` False forever — the dead end the whole ticket is about.
    """
    hub["post"] = _FakeResponse(409, _CONFLICT)
    proj = _project()

    assert await proj.share() is proj
    assert proj.remote is True, "a 409 still means this project IS on the hub"
    assert proj.hub_published_at, "an adopted row is published, so the marker must be stamped"
    assert ("GET", f"/graph/project/{proj.id}") in hub["calls"], "the 409 must be confirmed by a GET"


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_share_refuses_a_409_row_this_account_cannot_reach(hub):
    """A cloned repo carries the original author's ``.flow/id`` — never adopt it.

    The message must name what to DO; the hub's "a conflicting record already
    exists" describes a database constraint and leaves the reader stuck.
    """
    hub["post"] = _FakeResponse(409, _CONFLICT)
    hub["get"] = _FakeResponse(404, _HIDDEN)
    proj = _project()

    with pytest.raises(RuntimeError, match="cannot reach it"):
        await proj.share()

    assert proj.remote is not True, "an unreachable row must not be claimed as published"
    assert not proj.hub_published_at, "nor marked as published by this account"


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
@pytest.mark.parametrize("status", [400, 500, 503])
async def test_share_still_raises_on_a_real_failure(hub, status):
    """Only 409 is tolerated. A hub outage must stay an outage, not become
    "already published" — the flip below the POST would be a lie."""
    hub["post"] = _FakeResponse(status, '{"detail":"boom"}')
    proj = _project()

    with pytest.raises(ValueError, match=str(status)):
        await proj.share()

    assert proj.remote is not True
    assert [m for m, _ in hub["calls"]] == ["POST"], "a non-409 must not probe"
