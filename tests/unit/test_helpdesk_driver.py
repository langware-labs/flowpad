"""The help-desk driver: hub pool + ticket messages in, SourceItems out.

Offline by construction — the hub seams are monkeypatched, so this runs with
no network, no hub and no credentials. Three of these are about traps:

* every record must carry the hub's OWN ids as adoption hints, or the
  projection mints a twin conversation beside the hub-mirrored one;
* `send` must pick the ticket up before answering when this identity is not
  yet a participant — the hub fans a ticket out to participants only;
* a hub that is merely unreachable must not park the source, while "not a
  member of this desk" must, in words a person can act on.
"""
from __future__ import annotations

import json
import uuid
from pathlib import Path
from types import SimpleNamespace

import pytest

from flow_sdk.builtin.source_item import HelpdeskMessageSpec
from flow_sdk.cloud_client.shared.errors import HubError
from flow_sdk.ingest.driver import get_driver
from flow_sdk.ingest.drivers.helpdesk import HelpdeskDriver
from flow_sdk.ingest.health import SourceError, SourceHealth
from flow_sdk.schema.data_spec.choice_spec import Choice

pytestmark = [pytest.mark.timeout(30)]  # do not increase timeout without approval

DESK = "4f9f1fd1-39b6-5465-9c20-cb4c59b08318"
TICKET = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
ME = "11111111-1111-4111-8111-111111111111"
GUEST = "22222222-2222-4222-8222-222222222222"

POOL = [
    {"conversation_id": TICKET, "title": None, "preview": "my printer is broken", "initiated_by": GUEST,
     "message_count": 1, "participant_count": 1, "picked_up": False,
     "created_at": "2026-09-06T10:00:00+00:00", "updated_at": "2026-09-06T10:00:00+00:00"},
]
MSG = {"id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "text": "my printer is broken", "sender_id": GUEST,
       "sender_name": "Guest", "created_date": "2026-09-06T10:00:00+00:00", "updated_date": "2026-09-06T10:00:00+00:00"}


def _source(**config):
    base = {"desk_project_id": DESK}
    base.update(config)
    return SimpleNamespace(id=f"ds-{uuid.uuid4().hex[:8]}", name="Desk", provider="helpdesk", config=base,
                           account_key="", account_identities=[])


def _cursor(state=None):
    return SimpleNamespace(segment_key=TICKET, state=state or {}, window_start=None, first_run=not state)


def _hub(monkeypatch, *, pool=None, messages=None, error=None, calls=None, participants=(), user=ME):
    async def fake_get_or_raise(entity_type, entity_id=None, action=None, sub_path=None, *, params=None, **_):
        if calls is not None:
            calls.append(("get", str(getattr(entity_type, "value", entity_type)), entity_id, action))
        if error is not None:
            raise error
        if action == "helpdesk_conversations":
            return pool if pool is not None else []
        if action == "flow_message":
            return messages if messages is not None else []
        return {}

    async def fake_get(entity_type, entity_id=None, action=None, *args, **_):
        if calls is not None:
            calls.append(("get", str(getattr(entity_type, "value", entity_type)), entity_id, action))
        return {"id": entity_id, "participants": [{"user_id": p} for p in participants]}

    async def fake_post(entity_type, payload, entity_id=None, action=None, *args, **_):
        if calls is not None:
            calls.append(("post", str(getattr(entity_type, "value", entity_type)), entity_id, action))
        return {"id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc", **payload}

    monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_get_or_raise", fake_get_or_raise)
    monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_get", fake_get)
    monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_post", fake_post)
    monkeypatch.setattr("flow_sdk.ingest.drivers.helpdesk._hub_user_id", lambda: user)


class TestItIsAPluggableDriver:
    def test_it_is_registered_and_sends(self):
        import flow_sdk.ingest.drivers  # noqa: F401 — registers the shipped drivers

        driver = get_driver("helpdesk")
        assert driver is not None and driver.sends is True
        assert driver.open_inbound is True, "a desk exists to answer strangers"

    def test_its_record_kind_reaches_the_inbox(self):
        assert HelpdeskDriver.record_kind.startswith("content.message.")

    def test_the_channel_names_the_ticket_not_the_transport(self):
        assert HelpdeskDriver().channel_for(_source()) == "helpdesk"

    def test_the_manifest_matches_the_driver(self):
        """`spec.name == folder == driver.provider`, or `sends` reads false on the wire."""
        folder = Path("flow_sdk/system_projects/flowpad_assistant/agentic-assets/data_source/helpdesk")
        manifest = json.loads((folder / "data_source.json").read_text())
        assert manifest["name"] == HelpdeskDriver.provider == folder.name
        assert manifest["config"]["desk_project_id"]["choices"] is True
        assert HelpdeskDriver.choices is not None, "a choosable field needs its hook"
        assert "traits" not in manifest, "a builtin never declares traits"

    def test_replies_target_the_ticket(self):
        item = SimpleNamespace(segment_key=TICKET, thread_key=TICKET, external_id=MSG["id"])
        spec = HelpdeskDriver.outbound_spec(_source()).reply_to(item, body="try restarting it")
        assert isinstance(spec, HelpdeskMessageSpec)
        assert spec.to == [TICKET] and spec.thread_key == TICKET


class TestThePool:
    @pytest.mark.asyncio
    async def test_every_ticket_is_a_stream_picked_up_or_not(self, monkeypatch):
        _hub(monkeypatch, pool=POOL)
        streams = await HelpdeskDriver().segments(_source())
        assert [s.key for s in streams] == [TICKET]
        assert streams[0].label == "my printer is broken"

    @pytest.mark.asyncio
    async def test_a_source_without_a_desk_cannot_poll(self, monkeypatch):
        _hub(monkeypatch, pool=POOL)
        with pytest.raises(SourceError) as caught:
            await HelpdeskDriver().segments(_source(desk_project_id=""))
        assert caught.value.code == "no_desk"


class TestMapping:
    @pytest.mark.asyncio
    async def test_a_ticket_message_becomes_a_record_with_the_hub_ids_as_hints(self, monkeypatch):
        _hub(monkeypatch, messages=[MSG])
        item = (await HelpdeskDriver().fetch(_source(), _cursor())).items[0]
        assert item.external_id == MSG["id"]
        assert item.message_id == MSG["id"], "the projection must mint the FlowMessage with the hub's id"
        assert item.conversation_id == TICKET, "the projection must adopt the hub conversation"
        assert item.thread_key == TICKET, "the ticket id IS the thread key"
        assert item.segment_key == TICKET
        assert item.body == "my printer is broken"
        assert item.author_external_id == GUEST and item.author_display == "Guest"
        assert item.kind == "content.message.chat"

    @pytest.mark.asyncio
    async def test_the_cursor_is_a_watermark_on_updated_date(self, monkeypatch):
        _hub(monkeypatch, messages=[MSG])
        first = await HelpdeskDriver().fetch(_source(), _cursor())
        assert first.next_state["high_water"] == MSG["updated_date"]
        assert first.next_state["boundary_ids"] == [MSG["id"]]
        again = await HelpdeskDriver().fetch(_source(), _cursor(state=first.next_state))
        assert again.items == [] and again.unchanged is True

    @pytest.mark.asyncio
    async def test_an_edit_re_arrives_because_its_stamp_moved(self, monkeypatch):
        edited = {**MSG, "text": "my printer is on fire", "updated_date": "2026-09-06T10:05:00+00:00"}
        _hub(monkeypatch, messages=[edited])
        state = {"high_water": MSG["updated_date"], "boundary_ids": [MSG["id"]]}
        result = await HelpdeskDriver().fetch(_source(), _cursor(state=state))
        assert [i.body for i in result.items] == ["my printer is on fire"]

    @pytest.mark.asyncio
    async def test_the_first_fetch_records_who_we_answer_as(self, monkeypatch):
        """`self_addresses` reads `account_identities`; without it our own replies
        are attributed to a stranger and an agent answers itself."""
        _hub(monkeypatch, messages=[MSG])
        saved = []

        async def save(*_a, **_k):
            saved.append(True)

        src = _source()
        src.save = save
        await HelpdeskDriver().fetch(src, _cursor())
        assert src.account_identities == [ME] and saved


class TestSend:
    @pytest.mark.asyncio
    async def test_it_picks_the_ticket_up_before_answering(self, monkeypatch):
        calls = []
        _hub(monkeypatch, calls=calls, participants=(GUEST,))
        out = await HelpdeskDriver().send(_source(), thread_key=TICKET, to=TICKET, text="try restarting it")
        assert [c for c in calls if c[0] == "post"] == [
            ("post", "conversation", TICKET, "pickup"),
            ("post", "conversation", TICKET, "add_message"),
        ]
        assert out.recorded is False, "the next poll ingests the sent copy onto the hub's id"
        assert out.external_id == "cccccccc-cccc-4ccc-8ccc-cccccccccccc"

    @pytest.mark.asyncio
    async def test_pickup_is_sent_every_time_because_the_hub_makes_it_a_no_op(self, monkeypatch):
        """Already a participant: no read to find that out — the hub's pickup
        is idempotent, so the reply is two writes and never a read."""
        calls = []
        _hub(monkeypatch, calls=calls, participants=(GUEST, ME))
        await HelpdeskDriver().send(_source(), thread_key="", to=TICKET, text="still broken?")
        assert [c[0] for c in calls] == ["post", "post"]
        assert [c[3] for c in calls] == ["pickup", "add_message"]

    @pytest.mark.asyncio
    async def test_a_failed_reply_never_parks_the_source(self, monkeypatch):
        async def boom(*_a, **_k):
            raise HubError(403, "not a member")

        _hub(monkeypatch, participants=(ME,))
        monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_post", boom)
        with pytest.raises(HubError):
            await HelpdeskDriver().send(_source(), thread_key="", to=TICKET, text="x")


class TestErrorClassification:
    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "error,health,code",
        [
            (HubError(403, "forbidden"), SourceHealth.CONFIG_ERROR, "not_a_member"),
            # The hub answers 401 "Forbidden access" to a non-member, not 403.
            (HubError(401, "Forbidden access"), SourceHealth.CONFIG_ERROR, "not_a_member"),
            (HubError(404, "gone"), SourceHealth.CONFIG_ERROR, "no_desk"),
            (HubError(0, "hub not configured"), SourceHealth.CONFIG_ERROR, "hub_not_configured"),
            (HubError(0, "connection reset"), SourceHealth.TRANSIENT_ERROR, "network"),
            (HubError(429, "slow down"), SourceHealth.TRANSIENT_ERROR, "rate_limited"),
        ],
    )
    async def test_a_hub_failure_maps_to_the_right_health(self, monkeypatch, error, health, code):
        _hub(monkeypatch, error=error)
        with pytest.raises(SourceError) as caught:
            await HelpdeskDriver().fetch(_source(), _cursor())
        assert caught.value.health is health and caught.value.code == code

    @pytest.mark.asyncio
    async def test_signed_out_is_the_login_not_membership(self, monkeypatch):
        _hub(monkeypatch, error=HubError(401, "Forbidden access"), user="")
        with pytest.raises(SourceError) as caught:
            await HelpdeskDriver().fetch(_source(), _cursor())
        assert caught.value.code == "signed_out"

    @pytest.mark.asyncio
    async def test_a_membership_refusal_is_a_sentence_a_person_can_act_on(self, monkeypatch):
        _hub(monkeypatch, error=HubError(403, "forbidden"))
        with pytest.raises(SourceError) as caught:
            await HelpdeskDriver().segments(_source())
        assert "member" in caught.value.detail


class TestChoices:
    @pytest.mark.asyncio
    async def test_the_default_desk_is_offered(self, monkeypatch):
        from flow_sdk.app.actions.flow_message_action import HelpdeskTarget

        async def default():
            return HelpdeskTarget(DESK, None)

        async def none(_q):
            return []

        monkeypatch.setattr("flow_sdk.app.actions.flow_message_action._hub_default_helpdesk", default)
        monkeypatch.setattr("flow_sdk.builtin.helpdesk.Helpdesk.get_all", none)
        offered = await HelpdeskDriver().choices(_source(), "desk_project_id")
        assert offered and isinstance(offered[0], Choice) and offered[0].id == DESK
        assert await HelpdeskDriver().choices(_source(), "other") == []


class TestSegments:
    @pytest.mark.asyncio
    async def test_each_ticket_carries_the_pool_rows_change_token(self, monkeypatch):
        """`message_count:updated_at` from the pool row is the segment stamp,
        so the sync fetches a ticket only when the pool says it moved."""
        _hub(monkeypatch, pool=POOL)
        refs = await HelpdeskDriver().segments(_source())
        row = POOL[0]
        assert refs[0].key == row["conversation_id"]
        assert refs[0].stamp == f"{row['message_count']}:{row.get('updated_at') or ''}"
