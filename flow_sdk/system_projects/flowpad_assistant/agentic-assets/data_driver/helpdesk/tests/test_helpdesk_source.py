"""The ``helpdesk`` data source: hub pool and ticket messages in, replies out.

Offline by construction — the hub is a transport the source is handed, so these hand it a fake
one. Three are about traps: every record carries the hub's OWN ids (or the projection mints a
twin conversation beside the mirrored one); a reply picks the ticket up first (the hub fans a
ticket out to participants only); and "not a member of this desk" must park the source in words
a person can act on, while an unreachable hub must not.
"""
from __future__ import annotations

import json
import uuid
from pathlib import Path
from types import SimpleNamespace

import pytest

from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.builtin.source_item import HelpdeskMessageSpec
from flow_sdk.cloud_client.shared.errors import HubError
from flow_sdk.ingest.driver_registry import asset_module
from flow_sdk.ingest.health import SourceHealth, classify
from flow_sdk.ingest.testing import position
from flow_sdk.schema.data_spec.choice_spec import Choice
from flow_sdk.sources import UserProfile
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.errors import InvalidCursor, NotFound
from flow_sdk.sources.testing import Subject, checks_for

HelpdeskSource = asset_module("helpdesk").HelpdeskSource
AppHub = asset_module("helpdesk", "transport").AppHub
hub_refusal = asset_module("helpdesk", "transport").hub_refusal

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

DESK = "4f9f1fd1-39b6-5465-9c20-cb4c59b08318"
TICKET = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
ME = "11111111-1111-4111-8111-111111111111"
GUEST = "22222222-2222-4222-8222-222222222222"
POOL = [{"conversation_id": TICKET, "title": None, "preview": "my printer is broken", "initiated_by": GUEST, "message_count": 1,
         "participant_count": 1, "picked_up": False, "created_at": "2026-09-06T10:00:00+00:00", "updated_at": "2026-09-06T10:00:00+00:00"}]
MSG = {"id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "text": "my printer is broken", "sender_id": GUEST, "sender_name": "Guest",
       "created_date": "2026-09-06T10:00:00+00:00", "updated_date": "2026-09-06T10:00:00+00:00"}


class _Hub:
    """A hub that answers what it is told, records what it was asked, and knows its tickets."""

    def __init__(self, *, pool=None, messages=None, user=ME):
        self.pool, self.messages, self.user, self.calls, self.tickets = pool or [], list(messages or []), user, [], {TICKET}

    async def get(self, entity_type, entity_id, action):
        self.calls.append(("get", entity_type, entity_id, action))
        return self.pool if action == "helpdesk_conversations" else self.messages

    async def post(self, entity_type, payload, entity_id, action):
        self.calls.append(("post", entity_type, entity_id, action))
        if entity_id not in self.tickets:
            raise NotFound("no such ticket")
        if action == "add_message":
            sent = {"id": str(uuid.uuid4()), "text": payload["text"], "sender_id": ME, "created_date": "2026-09-06T11:00:00+00:00",
                    "updated_date": "2026-09-06T11:00:00+00:00"}
            self.messages.append(sent)
            return sent
        return {}

    def me(self):
        return self.user


def _row(**config):
    return SimpleNamespace(id=f"ds-{uuid.uuid4().hex[:8]}", name="Desk", provider="helpdesk",
                           config={"desk_project_id": DESK, **config}, account_key="", account_identities=[])


def _view(prior=None, *, cursor=None):
    return position(prior, cursor=cursor)


@pytest.fixture
def hub(monkeypatch):
    fake = _Hub(pool=POOL, messages=[MSG])
    monkeypatch.setattr(HelpdeskSource, "build", classmethod(lambda cls, binding: cls(binding, hub=fake)))
    return fake


@pytest.mark.parametrize("check", checks_for(HelpdeskSource), ids=str)
async def test_conformance(check):
    fake = _Hub(pool=POOL, messages=[{**MSG, "id": f"m{n}", "updated_date": f"2026-09-06T10:0{n}:00+00:00"} for n in (1, 2, 3)])
    binding = SourceBinding(config={"desk_project_id": DESK})
    probe = HelpdeskSource(binding, hub=fake)
    await check.run(Subject(
        source=lambda: HelpdeskSource(binding, hub=fake),
        conversation=probe.ticket_origin(TICKET),
        recipient=UserProfile(origin=probe.origin(GUEST), name="Guest"),
    ))


class TestTheSource:
    def test_it_is_registered_sends_and_answers_strangers(self):
        driver = DataDriver.loaded("helpdesk")
        assert driver.sends is True and driver.open_inbound is True and driver.channel_for(_row()) == "helpdesk"

    def test_the_manifest_matches_the_source(self):
        """`spec.name == folder == provider`, or `sends` reads false on the wire."""
        folder = Path("flow_sdk/system_projects/flowpad_assistant/agentic-assets/data_driver/helpdesk")
        manifest = json.loads((folder / "data_driver.json").read_text())
        assert manifest["name"] == HelpdeskSource.provider == folder.name
        assert manifest["config"]["desk_project_id"]["choices"] is True
        assert DataDriver.loaded("helpdesk").choices is not None, "a choosable field needs its hook"
        assert "traits" not in manifest, "a builtin never declares traits"

    def test_replies_target_the_ticket(self):
        item = SimpleNamespace(thread_key=TICKET, external_id=MSG["id"])
        spec = DataDriver.loaded("helpdesk").outbound_spec(_row()).reply_to(item, body="try restarting it")
        assert isinstance(spec, HelpdeskMessageSpec) and spec.to == [TICKET] and spec.thread_key == TICKET


OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
OTHER_ROW = {**POOL[0], "conversation_id": OTHER, "preview": "the wifi is down", "updated_at": "2026-09-06T09:00:00+00:00"}
OTHER_MSG = {**MSG, "id": "dddddddd-dddd-4ddd-8ddd-dddddddddddd", "text": "the wifi is down",
             "created_date": "2026-09-06T09:00:00+00:00", "updated_date": "2026-09-06T09:00:00+00:00"}


class _Desk(_Hub):
    """A hub whose tickets each hold their own messages."""

    def __init__(self, threads, pool):
        super().__init__(pool=pool)
        self.threads = threads

    async def get(self, entity_type, entity_id, action):
        self.calls.append(("get", entity_type, entity_id, action))
        return self.pool if action == "helpdesk_conversations" else self.threads.get(entity_id, [])

    def reads(self):
        return [c[2] for c in self.calls if c[3] == "flow_message"]


def _serve(monkeypatch, desk):
    monkeypatch.setattr(HelpdeskSource, "build", classmethod(lambda cls, binding: cls(binding, hub=desk)))
    return DataDriver.loaded("helpdesk")


class TestThePool:
    async def test_the_desk_is_one_stream_over_every_ticket_in_the_pool(self, monkeypatch):
        desk = _Desk({TICKET: [MSG], OTHER: [OTHER_MSG]}, [POOL[0], OTHER_ROW])
        result = await _serve(monkeypatch, desk).traverse(_row(), _view())
        assert sorted(i.thread_key for i in result.items) == sorted([TICKET, OTHER])
        assert sorted(desk.reads()) == sorted([TICKET, OTHER])

    async def test_a_ticket_whose_stamp_did_not_move_is_not_read(self, monkeypatch):
        desk = _Desk({TICKET: [MSG], OTHER: [OTHER_MSG]}, [POOL[0], OTHER_ROW])
        driver = _serve(monkeypatch, desk)
        first = await driver.traverse(_row(), _view())
        reply = {**MSG, "id": "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", "text": "have you tried turning it off",
                 "created_date": "2026-09-06T10:05:00+00:00", "updated_date": "2026-09-06T10:05:00+00:00"}
        desk.threads[TICKET].append(reply)
        desk.pool = [{**POOL[0], "message_count": 2, "updated_at": reply["updated_date"]}, OTHER_ROW]
        desk.calls.clear()
        second = await driver.traverse(_row(), _view(first))
        assert [i.external_id for i in second.items] == [reply["id"]]
        assert desk.reads() == [TICKET], "the idle ticket's stamp did not move, so it costs no fetch"
        desk.calls.clear()
        third = await driver.traverse(_row(), _view(second))
        assert third.items == [] and third.unchanged is True and desk.reads() == []

    async def test_a_new_ticket_is_picked_up_on_the_next_pass(self, monkeypatch):
        desk = _Desk({TICKET: [MSG]}, [POOL[0]])
        driver = _serve(monkeypatch, desk)
        first = await driver.traverse(_row(), _view())
        desk.threads[OTHER] = [OTHER_MSG]
        desk.pool = [POOL[0], OTHER_ROW]
        desk.calls.clear()
        second = await driver.traverse(_row(), _view(first))
        assert [(i.thread_key, i.external_id) for i in second.items] == [(OTHER, OTHER_MSG["id"])]
        assert desk.reads() == [OTHER]

    async def test_a_page_cut_inside_a_ticket_carries_on_inside_it(self):
        many = [{**MSG, "id": f"m{n}", "updated_date": f"2026-09-06T10:0{n}:00+00:00"} for n in (1, 2, 3)]
        desk = _Desk({TICKET: many, OTHER: [OTHER_MSG]}, [POOL[0], OTHER_ROW])
        got, cursor = [], None
        async with HelpdeskSource(SourceBinding(config={"desk_project_id": DESK}), hub=desk) as source:
            while True:
                page = await source.fetch(cursor, page_size=2)
                got.extend(i.origin.key for i in page.items)
                if (cursor := page.next_cursor) is None:
                    break
        assert got == ["m1", "m2", "m3", OTHER_MSG["id"]]

    async def test_a_malformed_desk_cursor_is_invalid(self, hub):
        async with HelpdeskSource(SourceBinding(config={"desk_project_id": DESK}), hub=hub) as source:
            for bad in ("desk:{", 'desk:{"watermark":""}', 'desk:{"watermark":"","tickets":{"t":"x"}}', "mark:{}"):
                with pytest.raises(InvalidCursor):
                    await source.fetch(bad)

    async def test_a_source_without_a_desk_cannot_poll(self, hub):
        with pytest.raises(Exception) as caught:
            await DataDriver.loaded("helpdesk").traverse(_row(desk_project_id=""), _view())
        assert classify(caught.value)[0] is SourceHealth.CONFIG_ERROR and "desk" in str(caught.value)


class TestMapping:
    async def test_a_ticket_message_becomes_a_record_with_the_hub_ids_as_hints(self, hub):
        (item,) = (await DataDriver.loaded("helpdesk").traverse(_row(), _view())).items
        assert item.external_id == MSG["id"] and item.message_id == MSG["id"], "the projection mints the FlowMessage with the hub's id"
        assert item.conversation_id == TICKET, "the projection adopts the hub conversation"
        assert (item.thread_key, item.body, item.kind) == (TICKET, "my printer is broken", "content.message.chat")
        assert (item.author_external_id, item.author_display) == (GUEST, "Guest")

    async def test_the_cursor_holds_each_tickets_change_token_and_message_watermark(self, hub):
        first = await DataDriver.loaded("helpdesk").traverse(_row(), _view())
        stamp = f"{POOL[0]['message_count']}:{POOL[0]['updated_at']}"
        assert first.cursor == HelpdeskSource.resume_at(POOL[0]["updated_at"], {TICKET: (stamp, MSG["updated_date"], [MSG["id"]])})
        again = await DataDriver.loaded("helpdesk").traverse(_row(), _view(first))
        assert again.items == [] and again.unchanged is True

    async def test_an_edit_re_arrives_because_its_stamp_moved(self, hub):
        hub.messages = [{**MSG, "text": "my printer is on fire", "updated_date": "2026-09-06T10:05:00+00:00"}]
        cursor = HelpdeskSource.resume_at(POOL[0]["updated_at"], {TICKET: ("1:earlier", MSG["updated_date"], [MSG["id"]])})
        result = await DataDriver.loaded("helpdesk").traverse(_row(), _view(cursor=cursor))
        assert [i.body for i in result.items] == ["my printer is on fire"]


class TestSend:
    async def test_it_picks_the_ticket_up_before_answering_every_time(self, hub):
        out = await DataDriver.loaded("helpdesk").send(_row(), thread_key=TICKET, to=TICKET, text="try restarting it")
        assert [c for c in hub.calls if c[0] == "post"] == [("post", "conversation", TICKET, "pickup"), ("post", "conversation", TICKET, "add_message")]
        assert out.recorded is True, "recorded at send, on the hub's id — the next poll's copy lands on the same row"
        assert out.external_id == hub.messages[-1]["id"]

    async def test_the_recorded_copy_carries_the_hub_ids_like_the_polled_one(self, hub):
        """The send-time copy and the next poll's copy are one message. Without the hub ids on the
        sent copy the projection mints a FlowMessage of its own, and the poll's copy (which has
        them) lands beside it: the staff reply shows twice."""
        from flow_sdk.builtin.source_item import SourceItem

        row = _row()
        out = await DataDriver.loaded("helpdesk").send(row, thread_key=TICKET, to=TICKET, text="try restarting it")
        (item,) = [i for i in await SourceItem.get_all({"data_source_id": str(row.id)}) if i.external_id == out.external_id]
        assert item.message_id == out.external_id, "the projection must land the sent copy on the hub's message id"
        assert item.conversation_id == TICKET, "the projection must adopt the hub conversation"

    async def test_a_send_records_who_we_answer_as(self, hub):
        saved = []

        async def save(*_a, **_k):
            saved.append(True)

        row = _row()
        row.save_runtime = save
        await DataDriver.loaded("helpdesk").send(row, thread_key="", to=TICKET, text="on it")
        assert row.account_identities == [ME] and saved

    async def test_a_failed_reply_never_parks_the_source(self, hub):
        hub.tickets = set()
        with pytest.raises(ValueError):
            await DataDriver.loaded("helpdesk").send(_row(), thread_key="", to=TICKET, text="x")


class TestTheAppHub:
    @pytest.mark.parametrize("error,signed_in,health,words", [
        (HubError(403, "forbidden"), True, SourceHealth.CONFIG_ERROR, "member"),
        (HubError(401, "Forbidden access"), True, SourceHealth.CONFIG_ERROR, "member"),
        (HubError(401, "Forbidden access"), False, SourceHealth.CONFIG_ERROR, "Log in"),
        (HubError(404, "gone"), True, SourceHealth.CONFIG_ERROR, "no longer exists"),
        (HubError(0, "hub not configured"), True, SourceHealth.CONFIG_ERROR, "not configured"),
        (HubError(0, "connection reset"), True, SourceHealth.TRANSIENT_ERROR, "reached"),
        (HubError(429, "slow down"), True, SourceHealth.TRANSIENT_ERROR, "429"),
    ])
    def test_a_hub_failure_maps_to_the_health_a_person_needs(self, error, signed_in, health, words):
        refusal = hub_refusal(error, signed_in=signed_in)
        assert classify(refusal)[0] is health and words in str(refusal)

    async def test_the_app_hub_raises_the_mapped_refusal(self, monkeypatch):
        async def refuse(*_a, **_k):
            raise HubError(403, "forbidden")

        monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_get_or_raise", refuse)
        monkeypatch.setattr(AppHub, "me", lambda self: ME)
        with pytest.raises(Exception) as caught:
            await AppHub().get("project", DESK, "helpdesk_conversations")
        assert classify(caught.value)[0] is SourceHealth.CONFIG_ERROR and "member" in str(caught.value)


class TestChoices:
    async def test_the_default_desk_is_offered(self, monkeypatch):
        from flow_sdk.app.actions.flow_message_action import HelpdeskTarget

        async def default():
            return HelpdeskTarget(DESK, None)

        async def none(_q):
            return []

        monkeypatch.setattr("flow_sdk.app.actions.flow_message_action._hub_default_helpdesk", default)
        monkeypatch.setattr("flow_sdk.builtin.helpdesk.Helpdesk.get_all", none)
        offered = await DataDriver.loaded("helpdesk").choices(_row(), "desk_project_id")
        assert offered and isinstance(offered[0], Choice) and offered[0].id == DESK
        assert await DataDriver.loaded("helpdesk").choices(_row(), "other") == []
