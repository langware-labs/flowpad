"""A message with no text is announced by what it carries — never by an invented sentence.

The send path used to fill an empty text with "Please run the following prompt:", so a
shared session raised a desktop notification about a prompt that did not exist.
"""

from flow_sdk.cloud_client.hub_bridge import _attachment_only_body


def _ref(type_id: str) -> dict:
    return {"attachment_type": "type_id", "data": type_id}


def test_a_shared_session_is_named_by_its_type_not_the_structural_refs():
    payload = {
        "attachment": [_ref("conversation-c1"), _ref("flow_message-m1"), _ref("claude_session-s1")],
        "attachment_filename": "body.flowmsg",
    }
    assert _attachment_only_body(payload) == "Sent you: claude_session"


def test_a_prompt_to_run_is_named_as_a_prompt():
    payload = {
        "attachment": [
            _ref("conversation-c1"),
            _ref("flow_message-m1"),
            _ref("prompt-p1"),
            _ref("remote_worker_session-r1"),
        ],
        "attachment_filename": "body.flowmsg",
    }
    assert _attachment_only_body(payload) == "Sent you: prompt"


def test_the_body_bundle_name_is_never_the_line():
    payload = {"attachment": [_ref("conversation-c1"), _ref("flow_message-m1")], "attachment_filename": "body.flowmsg"}
    assert _attachment_only_body(payload) == "Sent you a message"


def test_a_raw_file_is_named_by_its_file():
    payload = {"attachment": [_ref("conversation-c1")], "attachment_filename": "report.pdf"}
    assert _attachment_only_body(payload) == "report.pdf"
