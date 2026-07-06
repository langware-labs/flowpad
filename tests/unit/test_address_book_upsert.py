"""Address-book alignment: User.upsert_contact + the conversation scan.

Covers the generalized contact identity model (email OR user_id OR both) and the
single scan routine reused by the Refresh button (global) and the contact-detail
Conversations tab (scoped).
"""
from __future__ import annotations

import pytest

from flow_sdk.api.api_types.identifier import is_valid_entity_id


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_upsert_by_email_creates_and_dedups_and_backfills():
    from flow_sdk.builtin.user import User

    a = await User.upsert_contact(email="gadi@langware.ai")
    assert a is not None and a.email == "gadi@langware.ai"
    assert is_valid_entity_id(a.id)  # local id is a minted v4/v5 UUID

    # Same email → same row, no duplicate; name backfilled.
    b = await User.upsert_contact(email="gadi@langware.ai", name="Gadi Tunes")
    assert b.id == a.id
    assert b.name == "Gadi Tunes"

    everyone = await User.get_all({"email": "gadi@langware.ai"})
    assert len(everyone) == 1


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_upsert_by_user_id_email_less():
    from flow_sdk.builtin.user import User

    # A hub id that is NOT a UUID — must never become the local entity id.
    c = await User.upsert_contact(user_id="alice-hub-id", name="Alice")
    assert c is not None
    assert c.user_id == "alice-hub-id"
    assert c.email is None
    assert c.id != "alice-hub-id"
    assert is_valid_entity_id(c.id)

    # Re-upsert same user_id → same row (deterministic, no dup).
    again = await User.upsert_contact(user_id="alice-hub-id")
    assert again.id == c.id
    rows = await User.get_all({"user_id": "alice-hub-id"})
    assert len(rows) == 1


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_upsert_matches_by_user_id_then_backfills_email():
    from flow_sdk.builtin.user import User

    c = await User.upsert_contact(user_id="bob-hub-id")
    # Later we learn Bob's email + name for the same hub id.
    merged = await User.upsert_contact(user_id="bob-hub-id", email="bob@x.io", name="Bob")
    assert merged.id == c.id
    assert merged.email == "bob@x.io"
    assert merged.name == "Bob"


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_upsert_matches_participant_that_carries_local_id():
    from flow_sdk.builtin.user import User

    seed = await User.upsert_contact(email="ziv@thinkz.ai")
    # A local-origin participant carries the local entity id as its user_id.
    same = await User.upsert_contact(user_id=seed.id, name="Ziv Lavy")
    assert same.id == seed.id
    assert same.name == "Ziv Lavy"


async def _mk_conv(conv_id: str, participants: list[dict]):
    from flow_sdk.builtin.conversation import Conversation

    conv = Conversation(id=conv_id, participants=participants)
    await conv.save()
    return conv


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_scan_address_book_learns_all_rosters():
    from flow_sdk.app.actions.address_book_action import scan_address_book
    from flow_sdk.builtin.user import User

    await _mk_conv("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", [
        {"email": "gadi@langware.ai", "name": "Gadi Tunes"},
        {"user_id": "hub-nir", "name": "Nir Levy"},  # email-less
    ])
    await _mk_conv("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", [
        {"user_id": "hub-ziv", "email": "ziv@thinkz.ai", "name": "Ziv Lavy"},
    ])

    result = await scan_address_book()
    assert result["scanned_conversations"] == 2

    assert await User.get_by_identity(email="gadi@langware.ai") is not None
    assert await User.get_by_identity(user_id="hub-nir") is not None  # email-less learned
    assert await User.get_by_identity(email="ziv@thinkz.ai") is not None

    # Idempotent: a second scan creates no duplicates.
    await scan_address_book()
    assert len(await User.get_all({"user_id": "hub-nir"})) == 1


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_scoped_scan_returns_only_matching_conversations():
    from flow_sdk.app.actions.address_book_action import scan_address_book
    from flow_sdk.builtin.user import User

    # Unique identities: the session DB is not reset between tests, so scope by a
    # token no other test uses and assert on this test's two conversations.
    await _mk_conv("cccccccc-cccc-4ccc-8ccc-cccccccccccc", [
        {"email": "scoped-gadi@langware.ai", "name": "Gadi"},
    ])
    await _mk_conv("dddddddd-dddd-4ddd-8ddd-dddddddddddd", [
        {"user_id": "hub-ziv-scoped", "email": "ziv-scoped@thinkz.ai", "name": "Ziv"},
    ])

    ziv = await User.upsert_contact(user_id="hub-ziv-scoped", email="ziv-scoped@thinkz.ai")
    scoped = await scan_address_book(user_tokens=ziv.identity_tokens())
    ids = {c["id"] for c in scoped["conversations"]}
    assert "dddddddd-dddd-4ddd-8ddd-dddddddddddd" in ids
    assert "cccccccc-cccc-4ccc-8ccc-cccccccccccc" not in ids
