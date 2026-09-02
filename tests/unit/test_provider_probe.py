"""The connection test's three-valued answer.

A test button that reports success without testing anything is worse than no
test button, so "not checked" must never render as a pass — and an unverified
probe's rejection must never render as "your token is dead".
"""

import pytest

from flow_sdk.core.oauth.provider_probe import (
    ProbeResult,
    get_probe,
    identity_from_credential,
    run_probe,
    token_from_credential,
)


def test_every_shown_provider_has_a_probe():
    """The three providers the Connections tab lists. A missing probe is not a
    crash, it just makes the button useless for that row."""
    for provider in ("github", "slack", "anthropic"):
        assert get_probe(provider) is not None, provider


def test_probe_lookup_is_case_insensitive():
    assert get_probe("GitHub") is get_probe("github")


@pytest.mark.asyncio
async def test_an_unknown_provider_is_not_checked_rather_than_failed():
    result = await run_probe("madeup", "some-token")

    # None, not False: nothing was asked, so nothing was answered.
    assert result.ok is None
    assert "No connection test" in result.detail


@pytest.mark.asyncio
async def test_no_token_is_a_definite_failure():
    """This one IS a real answer: there is nothing to authenticate with."""
    result = await run_probe("github", "")

    assert result.ok is False
    assert "No token" in result.detail


@pytest.mark.asyncio
@pytest.mark.parametrize("body", ["not-json", "[]"])
async def test_success_status_with_invalid_body_is_never_a_pass(monkeypatch, body):
    import httpx

    def handler(_request):
        return httpx.Response(200, text=body)

    real_client = httpx.AsyncClient

    def client(*_args, **_kwargs):
        return real_client(transport=httpx.MockTransport(handler))

    monkeypatch.setattr(httpx, "AsyncClient", client)

    result = await run_probe("github", "token")

    assert result.ok is None
    assert result.code == "invalid_response"


def test_result_serializes_the_three_states_intact():
    # `ok` must survive as a JSON null, not collapse to false — the client
    # branches on all three.
    assert ProbeResult(ok=None, detail="d").as_data() == {
        "ok": None,
        "identity": None,
        "account_key": None,
        "detail": "d",
        "code": None,
    }
    assert ProbeResult(ok=False).as_data()["ok"] is False
    assert ProbeResult(ok=True, identity="serans1").as_data() == {
        "ok": True,
        "identity": "serans1",
        "account_key": None,
        "detail": None,
        "code": None,
    }


def test_slack_reads_its_error_out_of_a_200_body():
    """Slack answers HTTP 200 with ``{"ok": false}``, so status alone would call a
    dead token healthy."""
    probe = get_probe("slack")

    assert probe.method == "POST"
    assert probe.success_field == "ok"
    assert probe.error_field == "error"


def test_every_probe_is_strict_and_uses_the_declared_provider_endpoint():
    assert get_probe("github").url == "https://api.github.com/user"
    assert get_probe("slack").url == "https://slack.com/api/auth.test"
    assert get_probe("google").url == "https://www.googleapis.com/drive/v3/about"
    assert get_probe("anthropic").url == "https://api.anthropic.com/v1/organizations/me"


def test_the_bearer_is_extracted_from_every_stored_credential_shape():
    """Providers do not agree on what a stored credential looks like.

    GitHub's SOD entry is the token string. Anthropic's is the whole normalized
    OAuth response, a dict — sending THAT as the bearer would have read
    Anthropic's refusal of `Bearer {'provider': ...}` as a dead token, and the
    bug would only have appeared the moment someone logged in.
    """
    assert token_from_credential("gho_abc") == "gho_abc"
    assert token_from_credential({"provider": "anthropic", "access_token": "sk-ant-oat01"}) == "sk-ant-oat01"
    # A SOD driver may hand back the JSON it stored rather than a dict.
    assert token_from_credential('{"access_token": "sk-json"}') == "sk-json"

    for empty in (None, "", {}, {"refresh_token": "only-a-refresh"}):
        assert token_from_credential(empty) is None, empty


def test_identity_falls_back_to_what_the_credential_carries():
    """Anthropic's probe cannot name the holder, but its stored response can."""
    assert identity_from_credential({"email": "eran@langware.ai"}) == "eran@langware.ai"
    assert identity_from_credential("a bare token") is None
