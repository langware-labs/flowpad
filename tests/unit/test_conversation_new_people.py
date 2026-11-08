"""`flow conversation new` takes one or several people in <who>."""

from flow_sdk.cli.commands.conversation_cmd import split_people


def test_one_person_stays_one():
    assert split_people("gadi@langware.ai") == ["gadi@langware.ai"]


def test_commas_and_semicolons_both_separate_people():
    assert split_people("gadi@langware.ai, Tzahi Mazuz") == ["gadi@langware.ai", "Tzahi Mazuz"]
    assert split_people("gadi@langware.ai;Tzahi Mazuz; ami@x.io") == ["gadi@langware.ai", "Tzahi Mazuz", "ami@x.io"]


def test_blanks_and_repeats_are_dropped_in_order():
    assert split_people(" a@x.io ,, ;b@x.io, a@x.io ") == ["a@x.io", "b@x.io"]
    assert split_people(" , ; ") == []


def _run_new(monkeypatch, *, signed_in: bool):
    """Enter through the real `flow conversation new`; record every backend URL it posts to."""
    from typer.testing import CliRunner

    from flow_sdk.cli.commands import conversation_cmd as cc

    posted: list[str] = []

    def fake_post(url, body):
        posted.append(url)
        return {"id": "c1"} if url.endswith("/conversation") else {}

    monkeypatch.setattr(cc, "_discover_port", lambda: 1)
    monkeypatch.setattr(cc, "_post_json", fake_post)
    monkeypatch.setattr(cc, "_signed_in", lambda: signed_in)
    monkeypatch.setattr("flow_sdk.cli.commands.contacts_cmd.load_contacts", lambda port: [])
    result = CliRunner().invoke(cc.conversation_app, ["new", "nobody@x.io", "hi"])
    return result, posted


def test_new_never_lists_conversations_just_to_check_sign_in(monkeypatch):
    # conversation-list runs a full hub sync; `new` only needs the sign-in flag.
    _, posted = _run_new(monkeypatch, signed_in=True)
    assert not any("conversation-list" in u for u in posted)


def test_new_signed_out_fails_auth_required_before_any_call(monkeypatch):
    result, posted = _run_new(monkeypatch, signed_in=False)
    assert result.exit_code != 0
    assert "AUTH_REQUIRED" in result.output
    assert posted == []
