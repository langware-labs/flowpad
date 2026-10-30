"""Secured transfer crypto (``flow_sdk/secrets/sealed.py``): seal → open, every refusal, rotation."""
import json
from datetime import datetime, timedelta, timezone

import pytest

from flow_sdk.secrets.sealed import (
    SEALED_TTL,
    DeviceKeyPair,
    DeviceKeyring,
    SealedError,
    accept_advert,
    make_advert,
    open_sealed,
    seal,
    verify_advert,
)

SECRET = "abcd efgh SUPERSECRET"
CONV = "8ac819df-85cb-4a47-ae10-c41626eef3eb"


class Device:
    def __init__(self, user: str, device: str):
        self.user, self.device = user, device
        self.ring = DeviceKeyring(DeviceKeyPair.generate())
        self.advert = make_advert(self.ring.current, user_id=user, device_id=device)


@pytest.fixture
def world():
    return Device("alice", "alice-mac"), Device("bob", "bob-mac"), Device("bob", "bob-win")


def sealed(sender, recipients, **kw):
    return seal(
        sender.ring.current, sender_user_id=sender.user, sender_device_id=sender.device, conversation_id=CONV,
        recipients=[r.advert for r in recipients], credential_name="acme-gmail", credential_title="Acme Gmail",
        values={"ACME_GMAIL_APP_PASSWORD": SECRET, "ACME_GMAIL_ADDRESS": "sales@acme.test"}, **kw,
    )


def opened(env, receiver, sender, **kw):
    args = dict(device_id=receiver.device, sender_advert=sender.advert, sender_user_id=sender.user,
                conversation_id=CONV)
    args.update(kw)
    return open_sealed(env, receiver.ring, **args)


def test_every_recipient_device_opens_the_same_values(world):
    alice, bob_mac, bob_win = world
    env = sealed(alice, [bob_mac, bob_win])
    for device in (bob_mac, bob_win):
        payload = opened(env, device, alice)
        assert payload.credential_name == "acme-gmail"
        assert payload.values["ACME_GMAIL_APP_PASSWORD"].get_secret_value() == SECRET


def test_the_envelope_carries_no_value_and_no_name_in_the_clear(world):
    alice, bob, _ = world
    wire = json.dumps(sealed(alice, [bob]).model_dump(mode="json"))
    for leak in (SECRET, "sales@acme.test", "ACME_GMAIL", "acme-gmail"):
        assert leak not in wire


def test_a_payload_never_shows_a_value_in_its_repr(world):
    alice, bob, _ = world
    assert SECRET not in repr(opened(sealed(alice, [bob]), bob, alice))


@pytest.mark.parametrize("field, value", [("ciphertext", None), ("conversation_id", "other"), ("expires_at", "2999-01-01T00:00:00+00:00")])
def test_any_change_breaks_the_signature(world, field, value):
    alice, bob, _ = world
    env = sealed(alice, [bob])
    if value is None:
        raw = bytearray(env.ciphertext.encode()); raw[5] ^= 1; value = raw.decode(errors="ignore") or "x"
    with pytest.raises(SealedError) as e:
        opened(env.model_copy(update={field: value}), bob, alice, conversation_id=env.conversation_id if field != "conversation_id" else value)
    assert e.value.code in {"bad_signature", "undecryptable"}


def test_a_value_from_another_member_posing_as_the_sender_is_refused(world):
    alice, bob, _ = world
    mallory = Device("mallory", "m-1")
    forged = sealed(mallory, [bob]).model_copy(update={"sender_user_id": "alice", "sender_device_id": "alice-mac"})
    with pytest.raises(SealedError) as e:
        opened(forged, bob, alice)
    assert e.value.code == "bad_signature"


def test_the_hub_stamped_sender_must_match(world):
    alice, bob, _ = world
    with pytest.raises(SealedError) as e:
        opened(sealed(alice, [bob]), bob, alice, sender_user_id="mallory")
    assert e.value.code == "wrong_sender"


def test_moved_to_another_conversation_is_refused(world):
    alice, bob, _ = world
    with pytest.raises(SealedError) as e:
        opened(sealed(alice, [bob]), bob, alice, conversation_id="another")
    assert e.value.code == "wrong_conversation"


def test_expired_and_replayed_are_refused(world):
    alice, bob, _ = world
    env = sealed(alice, [bob])
    with pytest.raises(SealedError) as e:
        opened(env, bob, alice, now=datetime.now(timezone.utc) + SEALED_TTL + timedelta(minutes=1))
    assert e.value.code == "expired"
    with pytest.raises(SealedError) as e:
        opened(env, bob, alice, seen=[env.transfer_id])
    assert e.value.code == "replayed"


def test_a_device_it_was_not_sealed_for_cannot_open_it(world):
    alice, bob, _ = world
    carol = Device("carol", "carol-1")
    with pytest.raises(SealedError) as e:
        opened(sealed(alice, [bob]), carol, alice)
    assert e.value.code == "not_for_me"


def test_a_tampered_advert_is_refused(world):
    alice, _, _ = world
    with pytest.raises(SealedError):
        verify_advert(alice.advert.model_copy(update={"device_name": "evil"}))


# ── rotation ────────────────────────────────────────────────────────────────


def rotate(device: Device) -> None:
    previous = device.ring.rotate()
    device.advert = make_advert(device.ring.current, user_id=device.user, device_id=device.device, previous=previous)


def test_a_rotation_signed_by_the_previous_key_is_followed(world):
    _, bob, _ = world
    pinned = bob.advert
    rotate(bob)
    assert accept_advert(pinned, bob.advert).sign_pub == bob.advert.sign_pub


def test_a_new_key_the_pinned_key_did_not_sign_is_refused(world):
    _, bob, _ = world
    pinned = bob.advert
    impostor = DeviceKeyPair.generate()
    swapped = make_advert(impostor, user_id="bob", device_id="bob-mac")
    with pytest.raises(SealedError) as e:
        accept_advert(pinned, swapped)
    assert e.value.code == "key_changed"


def test_a_value_sealed_before_a_rotation_still_opens_after_it(world):
    alice, bob, _ = world
    env = sealed(alice, [bob])
    rotate(bob)
    assert opened(env, bob, alice).values["ACME_GMAIL_APP_PASSWORD"].get_secret_value() == SECRET
    # and a new value is sealed to the new key
    fresh = sealed(alice, [bob])
    assert fresh.recipients[0].key_id == bob.ring.current.key_id


def test_a_retired_key_is_dropped_once_what_was_sealed_to_it_expired(world):
    alice, bob, _ = world
    env = sealed(alice, [bob])
    rotate(bob)
    bob.ring.prune(now=datetime.now(timezone.utc) + SEALED_TTL + timedelta(days=1))
    with pytest.raises(SealedError) as e:
        opened(env, bob, alice)
    assert e.value.code == "key_gone"


def test_the_keyring_round_trips_through_its_stored_form(world):
    _, bob, _ = world
    rotate(bob)
    again = DeviceKeyring.load(json.loads(json.dumps(bob.ring.dump())))
    assert again.current.key_id == bob.ring.current.key_id
    assert [k.key_id for k, _ in again.retired] == [k.key_id for k, _ in bob.ring.retired]
