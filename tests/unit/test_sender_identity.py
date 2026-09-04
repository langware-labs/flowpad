"""What an agent's avatar becomes on a channel post.

`Agent.avatar` is ONE string with four possible meanings, and only one of them
can cross to Slack. The others must yield NOTHING rather than a guess: Slack's
`icon_emoji` takes a `:shortcode:` from Slack's own vocabulary, and its
`icon_url` is fetched by Slack's servers — so a lucide icon name, a repo icon
path and a local `avatar.png` all have nothing to point at.

This is the whole degradation contract, pinned here so nothing above it has to
re-test it.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from flow_sdk.inbox.sender_identity import SenderIdentity, emoji_shortcode, sender_identity


class TestTheAvatarTable:
    @pytest.mark.parametrize(
        ("avatar", "expected"),
        [
            ("💬", ":speech_balloon:"),
            ("🤖", ":robot_face:"),
            ("🧹", ":broom:"),
            ("✉️", ":envelope:"),
        ],
    )
    def test_a_covered_emoji_becomes_a_shortcode(self, avatar, expected):
        assert emoji_shortcode(avatar) == expected

    @pytest.mark.parametrize(
        "avatar",
        [
            "Search",  # a lucide icon name — the icon picker's usual output
            "icons/agent.svg",  # a repo icon path
            "./avatar.png",  # the uploaded-image sentinel
            "🫎",  # a real emoji we simply have no Slack name for
            "",
            None,
        ],
    )
    def test_everything_else_yields_no_icon(self, avatar):
        """No icon is the correct answer — Slack then shows the app's own.

        A raw emoji character in `icon_emoji` is rejected, and a name guessed
        from Unicode would be wrong: Slack's names are not Unicode's.
        """
        assert emoji_shortcode(avatar) == ""


class TestResolvingFromTheSource:
    @pytest.mark.asyncio
    async def test_a_source_with_no_agent_has_no_identity(self):
        """None, not an empty identity — so a caller leaves its payload alone."""
        assert await sender_identity(SimpleNamespace(config={})) is None

    @pytest.mark.asyncio
    async def test_an_agent_supplies_its_name_and_emoji(self, monkeypatch):
        agent = SimpleNamespace(title="", name="slack-summarizer", avatar="💬")

        async def _get(_id):
            return agent

        monkeypatch.setattr("flow_sdk.builtin.agent.Agent.get_by_id", _get)

        identity = await sender_identity(SimpleNamespace(config={"agent_id": "a-1"}))

        assert identity == SenderIdentity(username="slack-summarizer", icon_emoji=":speech_balloon:")

    @pytest.mark.asyncio
    async def test_a_name_without_a_usable_avatar_still_names_the_agent(self, monkeypatch):
        """The name is the load-bearing half; the icon is best-effort."""
        agent = SimpleNamespace(title="", name="researcher", avatar="Search")

        async def _get(_id):
            return agent

        monkeypatch.setattr("flow_sdk.builtin.agent.Agent.get_by_id", _get)

        identity = await sender_identity(SimpleNamespace(config={"agent_id": "a-1"}))

        assert identity is not None
        assert identity.username == "researcher"
        assert identity.icon_emoji == ""

    @pytest.mark.asyncio
    async def test_a_missing_agent_row_costs_a_name_not_a_message(self, monkeypatch):
        """Identity is a nicety — the post must still go out."""

        async def _missing(_id):
            return None

        monkeypatch.setattr("flow_sdk.builtin.agent.Agent.get_by_id", _missing)

        assert await sender_identity(SimpleNamespace(config={"agent_id": "a-1"})) is None

    @pytest.mark.asyncio
    async def test_an_unreadable_agent_row_does_not_raise(self, monkeypatch):
        async def _boom(_id):
            raise RuntimeError("db is gone")

        monkeypatch.setattr("flow_sdk.builtin.agent.Agent.get_by_id", _boom)

        assert await sender_identity(SimpleNamespace(config={"agent_id": "a-1"})) is None
