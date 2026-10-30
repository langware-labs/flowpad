"""Secured transfer end to end over an in-memory hub: two installs, one database (``flow_sdk/secrets/sealed_transfer.py``).

The fake hub enforces what the real one does (``flowpad/hub/builtin/device_key.py``): an install publishes only its
own key, members read each other's keys only through the conversation, messages are relayed as given and a hub
sender is stamped from the caller — never from the body.
"""
from __future__ import annotations

import copy
import json
import subprocess
from contextlib import contextmanager
from pathlib import Path

import pytest
from dotenv import dotenv_values

from flow_sdk.builtin.credential_service import declare_credential, set_credential_values
from flow_sdk.builtin.project import Project
from flow_sdk.secrets import sealed_transfer as st
from flow_sdk.secrets.sealed import SealedError

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

SECRET = "abcd efgh SUPERSECRET"
CONV = "conv-1"


class MemoryKeyStore:
    def __init__(self):
        self.data = None

    def load(self):
        return copy.deepcopy(self.data)

    def save(self, data):
        self.data = copy.deepcopy(data)

    def clear(self):
        self.data = None


class FakeHub:
    def __init__(self):
        self.keys: dict[str, dict[str, dict]] = {}
        self.members: dict[str, list[str]] = {CONV: []}
        self.messages: dict[str, list[dict]] = {CONV: []}
        self.caller = ""
        self.wire: list[str] = []  # every body that crossed to the hub

    async def call(self, method, entity_type, entity_id=None, action=None, sub_path=None, *, scope=None, params=None,
                   payload=None, **_):
        self.wire.append(json.dumps(payload or {}))
        et = str(getattr(entity_type, "value", entity_type))
        if et == "user" and action == "device_key":
            assert entity_id == self.caller, "an install publishes only its own key"
            if method == "PUT":
                advert = payload["advert"]
                self.keys.setdefault(self.caller, {})[advert["device_id"]] = advert
                return {"published": advert["device_id"]}
            if method == "DELETE":
                self.keys.get(self.caller, {}).pop((params or {}).get("device_id"), None)
                return {}
        if et == "conversation" and action == "list_members" and sub_path == "device_keys":
            if self.caller not in self.members[entity_id]:
                from flow_sdk.cloud_client.shared.errors import HubError

                raise HubError(403, "not a member")
            return [{"user_id": u, "devices": list(self.keys.get(u, {}).values())} for u in self.members[entity_id]]
        if et == "conversation" and action == "add_message":
            msg = {"id": f"m{sum(len(v) for v in self.messages.values()) + 1}", "sender_id": self.caller,
                   "kind": payload.get("kind"), "metadata": copy.deepcopy(payload.get("metadata") or {})}
            self.messages[entity_id].append(msg)
            return msg
        if et == "conversation" and action == "remove_message":
            self.messages[entity_id] = [m for m in self.messages[entity_id] if m["id"] != payload["flow_message_id"]]
            return {}
        if et == "flow_message" and scope:
            return copy.deepcopy(self.messages[scope[0][1]])
        raise AssertionError(f"unexpected hub call {method} {et} {action} {sub_path}")

    async def try_call(self, *a, **kw):
        return await self.call(*a, **kw)


class Install:
    """One Flowpad install: its user, device id, keychain, state folder and its own project + credential."""

    def __init__(self, hub, user, device, root: Path):
        self.hub, self.user, self.device = hub, user, device
        self.keys = MemoryKeyStore()
        self.state = root / f"state-{device}"
        self.state.mkdir(parents=True)
        self.project = None
        self.credential = None

    @contextmanager
    def acting(self, monkeypatch):
        self.hub.caller = self.user
        with monkeypatch.context() as m:
            m.setattr(st, "_user_id", lambda: self.user)
            m.setattr(st, "device_id", lambda: self.device)
            m.setattr(st, "_state_dir", lambda: self.state)
            previous = st.set_key_store(self.keys)
            try:
                yield self
            finally:
                st.set_key_store(previous)


@pytest.fixture
async def world(home, tmp_path, monkeypatch):
    from flow_sdk.cloud_client.hub_proxy import HubProxy

    hub = FakeHub()
    monkeypatch.setattr(HubProxy, "call", hub.call)
    monkeypatch.setattr(HubProxy, "try_call", hub.try_call)
    monkeypatch.setattr(st, "on_sealed_arrival", lambda *_: None)
    installs = {}
    for user, device in (("alice", "alice-mac"), ("bob", "bob-mac"), ("carol", "carol-1")):
        inst = Install(hub, user, device, tmp_path)
        mount = tmp_path / f"proj-{user}"
        mount.mkdir()
        subprocess.run(["git", "init", "-q"], cwd=mount, check=True)
        inst.project = Project(name=str(mount), fs_storage_mount_path=str(mount))
        await inst.project.save()
        inst.credential = await declare_credential(
            {"name": "acme-gmail", "title": "Acme Gmail", "setup": "manual",
             "vars": {"ACME_GMAIL_ADDRESS": {}, "ACME_GMAIL_APP_PASSWORD": {}, "ACME_KEY_FILE": {"kind": "file"}}},
            project_id=inst.project.id,
        )
        installs[user] = inst
    await set_credential_values(str(installs["alice"].credential.typeid),
                                {"ACME_GMAIL_ADDRESS": "sales@acme.test", "ACME_GMAIL_APP_PASSWORD": SECRET})
    hub.members[CONV] = ["alice", "bob", "carol"]
    return hub, installs


async def publish(inst, monkeypatch):
    with inst.acting(monkeypatch):
        return await st.publish_device_key()


def env_of(inst) -> dict:
    return dict(dotenv_values(Path(inst.project.fs_storage_mount_path) / ".env.local"))


async def share(world, monkeypatch, recipients=("bob",)):
    hub, inst = world
    with inst["alice"].acting(monkeypatch):
        return await st.seal_credential(str(inst["alice"].credential.typeid), CONV, list(recipients))


async def test_alice_shares_and_bob_fills_in_one_click_each(world, monkeypatch):
    hub, inst = world
    for who in ("alice", "bob"):
        await publish(inst[who], monkeypatch)
    sent = await share(world, monkeypatch)
    assert sent["sealed_for"] == ["bob"] and sent["cannot_receive"] == []

    with inst["bob"].acting(monkeypatch):
        cards = await st.incoming(CONV)
        assert [c["state"] for c in cards] == ["pending"]
        assert cards[0]["credential_name"] == "acme-gmail" and SECRET not in json.dumps(cards)
        done = await st.fill(CONV, cards[0]["message_id"], project_id=inst["bob"].project.id)
    assert done["filled"] == ["ACME_GMAIL_ADDRESS", "ACME_GMAIL_APP_PASSWORD"]
    assert env_of(inst["bob"])["ACME_GMAIL_APP_PASSWORD"] == SECRET

    with inst["alice"].acting(monkeypatch):
        status = await st.sent_status(CONV)
    assert status[0]["recipients"] == {"bob": "filled"}
    # every recipient answered: the envelope is gone from the hub
    assert not [m for m in hub.messages[CONV] if m["kind"] == st.SEALED_KIND]
    # nothing that crossed to the hub carries the value or the credential's names
    for leak in (SECRET, "sales@acme.test", "ACME_GMAIL", "acme-gmail"):
        assert not any(leak in body for body in hub.wire), leak


async def test_a_member_without_a_key_gets_no_values(world, monkeypatch):
    hub, inst = world
    await publish(inst["alice"], monkeypatch)
    sent = await share(world, monkeypatch, recipients=("bob",))
    assert sent["sealed_for"] == [] and sent["cannot_receive"] == ["bob"] and sent["transfer_id"] is None
    assert not [m for m in hub.messages[CONV] if m["kind"] == st.SEALED_KIND]


async def test_mixed_recipients_seal_only_for_those_with_a_key(world, monkeypatch):
    hub, inst = world
    for who in ("alice", "bob"):
        await publish(inst[who], monkeypatch)
    sent = await share(world, monkeypatch, recipients=("bob", "carol"))
    assert sent["sealed_for"] == ["bob"] and sent["cannot_receive"] == ["carol"]
    with inst["alice"].acting(monkeypatch):
        assert await st.receivers(CONV) == {"bob": "ok", "carol": "no_key"}


async def test_receiving_off_withdraws_the_key(world, monkeypatch):
    hub, inst = world
    await publish(inst["bob"], monkeypatch)
    assert hub.keys["bob"]
    monkeypatch.setattr(st, "receiving_enabled", lambda: False)
    await publish(inst["bob"], monkeypatch)
    assert hub.keys["bob"] == {}


async def test_decline_writes_nothing_and_tells_the_sender(world, monkeypatch):
    hub, inst = world
    for who in ("alice", "bob"):
        await publish(inst[who], monkeypatch)
    await share(world, monkeypatch)
    with inst["bob"].acting(monkeypatch):
        card = (await st.incoming(CONV))[0]
        await st.decline(CONV, card["message_id"])
        assert [c["state"] for c in await st.incoming(CONV)] == ["declined"]
    assert "ACME_GMAIL_APP_PASSWORD" not in env_of(inst["bob"])
    with inst["alice"].acting(monkeypatch):
        assert (await st.sent_status(CONV))[0]["recipients"] == {"bob": "declined"}
    with inst["bob"].acting(monkeypatch):
        assert await st.incoming(CONV) == []  # answered by everyone: the sender removed the envelope


async def test_a_replayed_envelope_is_not_filled_twice(world, monkeypatch):
    hub, inst = world
    for who in ("alice", "bob"):
        await publish(inst[who], monkeypatch)
    await share(world, monkeypatch)
    replay = copy.deepcopy([m for m in hub.messages[CONV] if m["kind"] == st.SEALED_KIND][0])
    with inst["bob"].acting(monkeypatch):
        await st.fill(CONV, (await st.incoming(CONV))[0]["message_id"], project_id=inst["bob"].project.id)
        replay["id"] = "replayed"
        hub.messages[CONV].append(replay)
        hub.messages[CONV] = [m for m in hub.messages[CONV] if m["kind"] != st.ACK_KIND]  # the hub "forgets" the ack
        with pytest.raises(SealedError) as e:
            await st.fill(CONV, "replayed", project_id=inst["bob"].project.id)
    assert e.value.code == "replayed"


async def test_a_tampered_envelope_is_refused(world, monkeypatch):
    hub, inst = world
    for who in ("alice", "bob"):
        await publish(inst[who], monkeypatch)
    await share(world, monkeypatch)
    msg = [m for m in hub.messages[CONV] if m["kind"] == st.SEALED_KIND][0]
    msg["metadata"][st.SEALED_KIND]["expires_at"] = "2999-01-01T00:00:00+00:00"
    with inst["bob"].acting(monkeypatch):
        card = (await st.incoming(CONV))[0]
        assert card["state"] == "bad_signature"
        with pytest.raises(SealedError):
            await st.fill(CONV, card["message_id"], project_id=inst["bob"].project.id)
    assert "ACME_GMAIL_APP_PASSWORD" not in env_of(inst["bob"])


async def test_another_member_cannot_send_as_the_sender(world, monkeypatch):
    hub, inst = world
    for who in ("alice", "bob", "carol"):
        await publish(inst[who], monkeypatch)
    await set_credential_values(str(inst["carol"].credential.typeid), {"ACME_GMAIL_APP_PASSWORD": "attacker"})
    with inst["carol"].acting(monkeypatch):
        await st.seal_credential(str(inst["carol"].credential.typeid), CONV, ["bob"])
    forged = [m for m in hub.messages[CONV] if m["kind"] == st.SEALED_KIND][-1]
    forged["metadata"][st.SEALED_KIND].update(sender_user_id="alice", sender_device_id="alice-mac")
    with inst["bob"].acting(monkeypatch):
        card = (await st.incoming(CONV))[-1]
    # the hub stamped carol as the sender: alice's device is not among carol's keys, so it never opens
    assert card["state"] in {"unknown_sender", "wrong_sender", "bad_signature"}


async def test_rotation_keeps_in_flight_values_openable_and_new_ones_sealed_to_the_new_key(world, monkeypatch):
    hub, inst = world
    for who in ("alice", "bob"):
        await publish(inst[who], monkeypatch)
    await share(world, monkeypatch)
    old_key = hub.keys["bob"]["bob-mac"]["key_id"]
    with inst["bob"].acting(monkeypatch):
        await st.publish_device_key(rotate=True)
    new_key = hub.keys["bob"]["bob-mac"]["key_id"]
    assert new_key != old_key and hub.keys["bob"]["bob-mac"]["prev_sign_pub"]
    # alice follows the countersigned rotation silently and seals a new share to the new key
    await share(world, monkeypatch)
    envs = [m["metadata"][st.SEALED_KIND] for m in hub.messages[CONV] if m["kind"] == st.SEALED_KIND]
    assert [e["recipients"][0]["key_id"] for e in envs] == [old_key, new_key]
    with inst["bob"].acting(monkeypatch):
        assert [c["state"] for c in await st.incoming(CONV)] == ["pending", "pending"]


async def test_an_unsigned_key_swap_is_not_followed(world, monkeypatch):
    hub, inst = world
    for who in ("alice", "bob"):
        await publish(inst[who], monkeypatch)
    with inst["alice"].acting(monkeypatch):
        await st.member_keys(CONV)  # alice pins bob's key
    inst["bob"].keys.clear()  # the hub (or a reinstall) presents a different key for the same device
    await publish(inst["bob"], monkeypatch)
    sent = await share(world, monkeypatch)
    assert sent["cannot_receive"] == ["bob"]


async def test_values_fill_only_what_the_receivers_credential_declares(world, monkeypatch):
    hub, inst = world
    for who in ("alice", "bob"):
        await publish(inst[who], monkeypatch)
    from flow_sdk.builtin.credential import Credential

    narrow = await declare_credential({"name": "acme-gmail", "setup": "manual", "vars": {"ACME_GMAIL_ADDRESS": {}}},
                                      project_id=inst["bob"].project.id)
    assert isinstance(narrow, Credential)
    await share(world, monkeypatch)
    with inst["bob"].acting(monkeypatch):
        card = (await st.incoming(CONV))[0]
        with pytest.raises(SealedError) as e:
            await st.fill(CONV, card["message_id"], project_id=inst["bob"].project.id)
    assert e.value.code == "undeclared"
    assert "ACME_GMAIL_ADDRESS" not in env_of(inst["bob"])


async def test_a_file_value_that_looks_like_a_path_is_written_literally(world, monkeypatch, tmp_path):
    hub, inst = world
    for who in ("alice", "bob"):
        await publish(inst[who], monkeypatch)
    probe = tmp_path / "private.key"
    probe.write_text("RECEIVER-PRIVATE")
    with inst["alice"].acting(monkeypatch):
        from flow_sdk.builtin.credential_resolver import resolve_project_secrets  # noqa: F401
        monkeypatch.setattr(
            "flow_sdk.builtin.credential_resolver.resolve_project_secrets",
            _fixed_values({"ACME_KEY_FILE": f"@{probe}"}),
        )
        await st.seal_credential(str(inst["alice"].credential.typeid), CONV, ["bob"])
    monkeypatch.undo()
    hub.caller = "bob"
    with inst["bob"].acting(monkeypatch):
        from flow_sdk.cloud_client.hub_proxy import HubProxy
        monkeypatch.setattr(HubProxy, "call", hub.call)
        monkeypatch.setattr(HubProxy, "try_call", hub.try_call)
        card = (await st.incoming(CONV))[0]
        await st.fill(CONV, card["message_id"], project_id=inst["bob"].project.id)
    written = Path(env_of(inst["bob"])["ACME_KEY_FILE"]).read_text()
    assert written == f"@{probe}" and "RECEIVER-PRIVATE" not in written


def _fixed_values(values):
    from pydantic import SecretStr

    async def resolve(*_a, **_k):
        return {k: SecretStr(v) for k, v in values.items()}

    return resolve


async def test_seal_and_fill_refuse_a_worker_or_a_served_app(world):
    from starlette.requests import Request

    from flow_sdk.app.actions.credentials_action import _from_a_person

    def req(headers):
        return Request({"type": "http", "headers": [(k.encode(), v.encode()) for k, v in headers.items()]})

    assert _from_a_person(req({"referer": "http://localhost:5036/dock/assets/credential-x"}))
    assert not _from_a_person(req({"x-cookie-gate": "secret"}))
    assert not _from_a_person(req({"referer": "http://localhost:9007/api/v1/graph/service_endpoint/e/service/app/"}))
