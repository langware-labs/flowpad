"""Message templating: a message → its template → a new message somewhere else (fields and body)."""

import io
import json
import zipfile
from datetime import datetime, timedelta, timezone

from flow_sdk.builtin.flow_message_bundle import rehome_bundle
from flow_sdk.builtin.message_template import MessageTemplate, instantiate, pick_template, requires_body, template_from

SRC, CONV, OTHER_CONV = "11111111-1111-4111-8111-111111111111", "c0000000-0000-4000-8000-000000000001", "c2"
CONTENT = [
    {"attachment_type": "file", "data": "data/logo.png"},
    {"attachment_type": "type_id", "data": "skill-s1"},
    {"attachment_type": "type_id", "data": f"conversation-{OTHER_CONV}"},  # a conversation shared AS content
    {"attachment_type": "prompt", "data": "try me", "proposer_id": "u1"},
]
SOURCE = {
    "id": SRC,
    "conversation_id": CONV,
    "text": "Welcome!",
    "instruction": "be kind",
    "attachment": [
        {"attachment_type": "type_id", "data": f"conversation-{CONV}"},
        {"attachment_type": "type_id", "data": f"flow_message-{SRC}"},
        *CONTENT,
    ],
    "shared_context_entities": [f"conversation-{CONV}", "skill-s1"],
    "metadata": {"k": 1},
    "sender_id": "u1",
    "sender_name": "Shlomo",
    "delivery_status": "received",
    "body_status": "ready",
    "reply_to_id": "r1",
    "thread_root_id": "t1",
    "cloned_from_id": "x",
    "invite": {"state": "pending"},
    "created_date": "2026-01-01",
}


def test_template_keeps_content_and_cuts_every_tie_to_its_place():
    t = template_from(SOURCE)
    assert t == MessageTemplate(
        text="Welcome!",
        instruction="be kind",
        attachment=CONTENT,
        shared_context_entities=["skill-s1"],
        metadata={"k": 1},
    )
    assert requires_body(t.attachment)
    assert not requires_body([{"attachment_type": "url", "data": "https://x"}, {"attachment_type": "prompt", "data": "hi"}])


def test_instantiate_ties_the_template_to_the_new_place():
    m = instantiate(template_from(SOURCE), conversation_id="new-c", sender_id="u1", sender_name="Shlomo")
    assert m["id"] and m["id"] != SRC
    assert m["conversation_id"] == "new-c"
    assert m["attachment"][:2] == [
        {"attachment_type": "type_id", "data": "conversation-new-c"},
        {"attachment_type": "type_id", "data": f"flow_message-{m['id']}"},
    ]
    assert m["attachment"][2:] == CONTENT
    assert m["shared_context_entities"] == ["conversation-new-c", "skill-s1"]
    assert (m["sender_id"], m["sender_name"], m["metadata"]) == ("u1", "Shlomo", {"k": 1})
    for gone in ("delivery_status", "body_status", "reply_to_id", "thread_root_id", "cloned_from_id", "invite"):
        assert gone not in m
    # a template of the new message is the same template: the round trip is stable
    assert template_from(m) == template_from(SOURCE)


NOW = datetime(2026, 11, 17, 12, 0, tzinfo=timezone.utc)
AGE = timedelta(minutes=30)


def _msg(sender, minutes_ago, **kw):
    return {"sender_id": sender, "created_date": NOW - timedelta(minutes=minutes_ago), **kw}


def test_pick_is_the_newest_by_the_author_that_has_stood_long_enough():
    old, older = _msg("u1", 31, text="b"), _msg("u1", 90, text="a")
    young, other = _msg("u1", 5, text="draft"), _msg("u2", 40, text="reply")
    assert pick_template([older, old, young, other], author_id="u1", now=NOW, min_age=AGE) is old
    assert pick_template([_msg("u1", 30, text="edge")], author_id="u1", now=NOW, min_age=AGE)["text"] == "edge"
    assert pick_template([young, other], author_id="u1", now=NOW, min_age=AGE) is None
    assert pick_template([], author_id="u1", now=NOW, min_age=AGE) is None


def test_pick_never_falls_back_past_a_body_still_uploading():
    body = [{"attachment_type": "file", "data": "data/a.png"}]
    uploading = _msg("u1", 40, attachment=body, body_status="uploading")
    ready = _msg("u1", 40, attachment=body, body_status="ready")
    assert pick_template([_msg("u1", 90), uploading], author_id="u1", now=NOW, min_age=AGE) is None
    assert pick_template([ready], author_id="u1", now=NOW, min_age=AGE) is ready


def _zip(files: dict[str, str]) -> bytes:
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as zf:
        for name, body in files.items():
            zf.writestr(name, body)
    return out.getvalue()


def test_rehome_bundle_rehomes_the_body_and_drops_the_source_conversation():
    packed = {**SOURCE, "attachment": [*SOURCE["attachment"][:2], {"attachment_type": "file", "data": "attachment/files/logo.png"}]}
    bundle = _zip(
        {
            "flow_message.json": json.dumps(packed),
            f"attachment/conversation-{CONV}/header.json": json.dumps({"id": CONV, "members": ["a@x", "b@x"]}),
            f"attachment/conversation-{CONV}/conversation.jsonl": "{}\n",
            f"attachment/conversation-{OTHER_CONV}/header.json": json.dumps({"id": OTHER_CONV}),
            f"attachment/flow_message-{SRC}/header.json": json.dumps(packed),
            "attachment/files/logo.png": "PNG",
            "attachment/skill-s1/SKILL.md": "# s1",
        }
    )
    new = instantiate(template_from(SOURCE), conversation_id="new-c", sender_id="u1", sender_name="Shlomo")
    with zipfile.ZipFile(io.BytesIO(rehome_bundle(bundle, new))) as zf:
        names = set(zf.namelist())
        envelope = json.loads(zf.read("flow_message.json"))
        entry = json.loads(zf.read(f"attachment/flow_message-{new['id']}/header.json"))
    assert names == {
        "flow_message.json",
        f"attachment/conversation-{OTHER_CONV}/header.json",
        f"attachment/flow_message-{new['id']}/header.json",
        "attachment/files/logo.png",
        "attachment/skill-s1/SKILL.md",
    }
    for header in (envelope, entry):
        assert (header["id"], header["conversation_id"], header["sender_id"]) == (new["id"], "new-c", "u1")
        # the packed form's own file path survives, not the stored row's
        assert header["attachment"][2:] == [{"attachment_type": "file", "data": "attachment/files/logo.png"}]
        assert "reply_to_id" not in header and "created_date" not in header
