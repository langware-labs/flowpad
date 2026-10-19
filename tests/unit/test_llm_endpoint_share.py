"""Sharing a budget from the box: ``endpoint.share([email])``.

The one-liner the UI leans on. Two things had to be true for it to work at all, and both are easy to
regress silently because the failure is quiet rather than loud:

* the generic ``share`` action fans ``recipients`` out only for the types that implement it, and
  "shares without invites" for everything else -- so a missing branch drops the emails on the floor
  and still answers 200;
* that action looks up a LOCAL row first, and an ``LLMEndpoint`` has none (it is a projection of hub
  state), so without the hub-only branch every share of one 404s.

The role is the security story: ``reader`` lets the recipient spend the budget and watch it drain,
and nothing else. Anything above it would let them raise the very cap they were given.
"""

import pytest

from flow_sdk.builtin.llm_endpoint import SHARE_ROLE, LLMEndpoint

ENDPOINT_ID = "11111111-1111-4111-8111-111111111111"


class _HubCalls:
    """Records what `share` asks the hub to do, instead of asking it."""

    def __init__(self):
        self.posts: list[tuple[str, str | None, str | None, dict]] = []

    async def post(self, entity_type, payload, entity_id=None, action=None, **kwargs):
        self.posts.append((entity_type, entity_id, action, payload))
        return {}


@pytest.fixture()
def hub_calls(monkeypatch):
    calls = _HubCalls()
    monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_post", calls.post)
    return calls


async def test_sharing_invites_each_recipient_as_a_reader(hub_calls):
    """One ``members`` POST per address, at ``reader``, landing on the endpoint's own page."""
    endpoint = LLMEndpoint(id=ENDPOINT_ID, name="team budget")

    await endpoint.share(["bob@example.com", "carol@example.com"])

    assert len(hub_calls.posts) == 2
    for (entity_type, entity_id, action, payload), email in zip(
        hub_calls.posts, ["bob@example.com", "carol@example.com"]
    ):
        assert (entity_type, entity_id, action) == ("llm_endpoint", ENDPOINT_ID, "members")
        assert payload["recipient_email"] == email
        assert payload["invitation_targets"] == [
            {"typeid": f"llm_endpoint-{ENDPOINT_ID}", "role": SHARE_ROLE}
        ]
        assert payload["callback_override"] == f"/dock/hub/llm-endpoints/{ENDPOINT_ID}"


async def test_sharing_never_creates_the_endpoint_on_the_hub(hub_calls):
    """``Entity.share()`` POSTs the entity to ``/graph/<type>`` to create it. That is meaningless for
    a hub-owned budget and would be a write where only an invitation was asked for, so ``share`` here
    overrides rather than extends -- every call must be a membership invite."""
    await LLMEndpoint(id=ENDPOINT_ID, name="team budget").share(["bob@example.com"])

    assert all(action == "members" for _t, _i, action, _p in hub_calls.posts), hub_calls.posts


async def test_the_share_role_is_spend_only():
    """Pinned as a constant, because raising it is a one-character change with a large blast radius:
    ``admin`` on an llm_endpoint may rewrite limits, replace the provider key, and allocate."""
    assert SHARE_ROLE == "reader"


async def test_no_recipients_is_a_no_op(hub_calls):
    """Nothing to invite, nothing to send -- and still no accidental hub create."""
    endpoint = LLMEndpoint(id=ENDPOINT_ID, name="team budget")

    await endpoint.share()
    await endpoint.share([])

    assert hub_calls.posts == []


async def test_addresses_are_normalized_not_merely_stripped(hub_calls):
    """Lowercasing is load-bearing, not tidiness: the hub stores and looks invitations up by exact
    match, so an invite addressed to ``Bob@x.com`` is one ``bob@x.com`` never sees. A blank row from
    a picker must also not become an invitation with an empty recipient."""
    await LLMEndpoint(id=ENDPOINT_ID, name="team budget").share(["  Bob@Example.COM ", "", "   "])

    assert [payload["recipient_email"] for *_head, payload in hub_calls.posts] == ["bob@example.com"]


async def test_the_entity_is_marked_hub_only():
    """What ``share_action`` branches on to skip the local-row lookup that would otherwise 404."""
    assert LLMEndpoint._hub_only is True
