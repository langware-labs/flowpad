"""The pieces around sending a diagnosis: what the Diagnose window sends, the recorded diagnosis
read back, and the one-shot repair of the support messages the outbox could never send."""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime

import pytest

from flow_sdk.app.actions.diagnose_action import diagnosis_value, parse_share
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.migrations import migration_2026_10_diagnosis_support_not_owed as mig
from flow_sdk.server.routes.bootstrap import get_or_create_local_user

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


def test_the_window_sends_who_and_when_as_json_or_multipart_text():
    picked = [{"kind": "person", "email": "eran@x.test", "name": "Eran"}, {"kind": "desk"}]

    as_json = parse_share({"share_with": picked, "send_when_done": True, "conversation_id": "c1"})
    as_form = parse_share({"share_with": json.dumps(picked), "send_when_done": "true", "conversation_id": "c1"})

    assert as_json == as_form
    assert [r.kind.value for r in as_json.recipients] == ["person", "desk"] and as_json.send_when_done
    assert parse_share({}).recipients == [] and not parse_share({}).send_when_done


def test_a_person_without_an_address_is_refused():
    with pytest.raises(ValueError):
        parse_share({"share_with": [{"kind": "person"}]})


async def test_a_record_reads_back_its_full_diagnosis_or_its_headline():
    class Old:
        diagnosis = None
        title, summary, symptoms, rca, fix = "one-liner", "short", "", "cause", "fix it"

    class New(Old):
        diagnosis = {"status": "needs_action", "title": "full", "summary": "s"}

    assert (await diagnosis_value(Old())).title == "one-liner"
    assert (await diagnosis_value(New())).title == "full"


async def _support_message(title: str, members: list) -> FlowMessage:
    user = await get_or_create_local_user()
    conv = await Conversation(id=str(uuid.uuid4()), title=title, members=members).save(user.typeid)
    msg = FlowMessage(text="summary", conversation_id=conv.id, sender_id=user.id, outbound=True)
    return await msg.save(user.typeid)


async def test_the_repair_clears_only_hidden_support_messages():
    stamp = datetime.now(UTC).strftime("%Y-%m-%d %H:%M")
    support = await _support_message(f"{mig.SUPPORT_TITLE} {stamp}", [])
    real = await _support_message(f"{mig.SUPPORT_TITLE} {stamp}", [{"email": "dana@x.test"}])
    assert support.owes_delivery and real.owes_delivery

    dry = await mig.repair(dry_run=True)
    assert dry["cleared"] == 0 and (await FlowMessage.get_one({"id": support.id})).owes_delivery

    done = await mig.repair(dry_run=False)
    assert done["cleared"] >= 1
    assert not (await FlowMessage.get_one({"id": support.id})).owes_delivery
    assert (await FlowMessage.get_one({"id": real.id})).owes_delivery, "a conversation with people is real mail"
    assert (await mig.repair(dry_run=False))["cleared"] == 0, "idempotent"
