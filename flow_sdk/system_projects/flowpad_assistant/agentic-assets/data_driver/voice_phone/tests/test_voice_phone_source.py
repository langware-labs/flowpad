"""The ``voice_phone`` source on its own: ``verify`` answers what it can check from here — the four
keys, and the number on the Twilio account — against the matrix's loopback Twilio, and a call we
place is ONE conversation, from the note that dials to the last sentence."""
from __future__ import annotations

import json

import pytest

from flow_sdk.ingest.driver_registry import SHIPPED_ROOT, asset_module, load_module
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.credentials import AuthShape, Credentials

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

VoicePhoneSource = asset_module("voice_phone").VoicePhoneSource
matrix = load_module(SHIPPED_ROOT / "voice_phone" / "tests", "matrix")


async def _source(double, *, drop: str = "", **config) -> "VoicePhoneSource":
    values = (await double.credentials(None)).values
    values = {k: v for k, v in values.items() if k != drop}
    return VoicePhoneSource(SourceBinding(config={**double.config, **config}, credentials=Credentials(shape=AuthShape.ENV, values=values)))


async def test_a_line_on_the_account_is_ready():
    async with matrix.Double() as double:
        verdict = await (await _source(double)).verify()
    assert verdict.ready, verdict
    assert "/api/v1/data_source/webhook/voice_phone" in verdict.detail
    assert double.dials == [], "a lookup is not a call"


async def test_a_number_not_on_the_account_is_not_ready():
    async with matrix.Double() as double:
        verdict = await (await _source(double, number="+14155559999")).verify()
    assert not verdict.ready and "+14155559999" in verdict.detail, verdict


async def test_a_missing_key_is_named(monkeypatch):
    monkeypatch.delenv("TWILIO_AUTH_TOKEN", raising=False)
    async with matrix.Double() as double:
        verdict = await (await _source(double, drop="TWILIO_AUTH_TOKEN")).verify()
    assert not verdict.ready and "TWILIO_AUTH_TOKEN" in verdict.detail, verdict


async def test_a_call_we_place_is_one_conversation_from_the_dial_on():
    async with matrix.Double() as double:
        source = await _source(double)
        async with source:
            note = await source.say_to(double.sender, "Confirm tomorrow's delivery window.")
        # the note names who the call is with, so the conversation knows its address before anyone speaks
        assert [p.address for p in note.data.recipients] == [double.sender]
        ring = double.rings_back()
        (call,) = source.calls_from_webhook(json.loads(ring["body"]))
    assert call.caller == double.sender and call.brief == "Confirm tomorrow's delivery window."
    assert note.data.conversation.key == f"{double.sender}/{call.conversation_key}", (note.data.conversation, call)
    assert call.conversation_key != call.call_id   # the dial's, known before the call had an id


async def test_a_call_to_us_is_its_own_conversation():
    async with matrix.Double() as double:
        source = await _source(double)
        raw = json.dumps(matrix.incoming_call("rtc_in1", caller=double.sender, dialled="proj_matrix",
                                              number_header=f"sip:{matrix.NUMBER}@pstn.twilio.com")).encode()
        (call,) = source.calls_from_webhook(json.loads(raw))
    assert call.conversation_key == "rtc_in1"


