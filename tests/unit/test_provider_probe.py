"""The connection test's three-valued answer.

A test button that reports success without testing anything is worse than no
test button, so "not checked" must never render as a pass — and an unverified
probe's rejection must never render as "your token is dead".
"""

import pytest

from flow_sdk.core.oauth.provider_probe import ProbeResult, get_probe, run_probe


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


def test_result_serializes_the_three_states_intact():
    # `ok` must survive as a JSON null, not collapse to false — the client
    # branches on all three.
    assert ProbeResult(ok=None, detail="d").as_data() == {"ok": None, "identity": None, "detail": "d"}
    assert ProbeResult(ok=False).as_data()["ok"] is False
    assert ProbeResult(ok=True, identity="serans1").as_data() == {
        "ok": True,
        "identity": "serans1",
        "detail": None,
    }


def test_slack_reads_its_error_out_of_a_200_body():
    """Slack answers HTTP 200 with ``{"ok": false}``, so status alone would call a
    dead token healthy."""
    probe = get_probe("slack")

    assert probe.body_error({"ok": False, "error": "invalid_auth"}) == "invalid_auth"
    assert probe.body_error({"ok": True, "user": "eran"}) is None


def test_only_the_unverified_probe_is_marked_as_such():
    """GitHub and Slack were exercised against their live APIs; Anthropic's could
    not be, for want of a claude.ai OAuth token."""
    assert get_probe("anthropic").unverified is True
    assert get_probe("github").unverified is False
    assert get_probe("slack").unverified is False
