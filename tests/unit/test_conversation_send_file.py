"""`flow conversation send --file`: the files go up multipart with every other send option as a
form field; without --file the send stays JSON; a missing file stops before anything is sent."""

import json

import pytest
from typer.testing import CliRunner

from flow_sdk.cli.commands import conversation_cmd as cc

CONV = "11111111-aaaa-4bbb-9ccc-000000000010"
REPLY = "11111111-aaaa-4bbb-9ccc-000000000070"


class _Resp:
    status_code = 200

    def json(self):
        return {"status": "SUCCESS", "data": {"flow_message_id": "m"}}


@pytest.fixture
def posts(monkeypatch):
    sent: list[dict] = []
    monkeypatch.setattr(cc, "_discover_port", lambda: 1)
    monkeypatch.setattr(cc, "_current_process_id", lambda: None)
    monkeypatch.setattr(cc, "_local_post", lambda url, **kw: sent.append(kw) or _Resp())
    return sent


def _send(*args):
    return CliRunner().invoke(cc.conversation_app, ["send", CONV, "her commits", *args])


def test_files_go_multipart_with_the_other_options_as_fields(posts, tmp_path):
    a, b = tmp_path / "a.bundle", tmp_path / "b.txt"
    a.write_bytes(b"\x00bundle")
    b.write_text("note")
    form = json.dumps({"title": "ok?", "fields": [{"id": "x", "label": "X", "type": "yesno", "default": True}]})
    result = _send("--file", str(a), "--file", str(b), "--prompt", "p", "--session", "s",
                   "--reply-to", REPLY, "--form", form)
    assert result.exit_code == 0, result.output
    [kw] = posts
    assert kw["files"] == [("files", ("a.bundle", b"\x00bundle")), ("files", ("b.txt", b"note"))]
    data = kw["data"]
    assert (data["text"], data["prompt_text"], data["remote_worker_session_id"], data["reply_to_id"]) == (
        "her commits", "p", "s", REPLY)
    assert json.loads(data["attachment"])[0]["data"]  # the form travels as JSON text


def test_without_file_the_send_stays_json(posts):
    assert _send().exit_code == 0
    [kw] = posts
    assert kw["json"]["text"] == "her commits" and "files" not in kw


def test_a_missing_file_sends_nothing(posts, tmp_path):
    result = _send("--file", str(tmp_path / "nope.bundle"))
    assert result.exit_code == cc.EXIT_INVALID_ARG
    assert posts == []
