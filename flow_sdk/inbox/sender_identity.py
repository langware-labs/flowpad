"""Who a channel post is FROM, when an agent owns the source.

The inbound half of a channel conversation already names the agent:
``_sender_for`` routes a source carrying ``agent_id`` through
``_agent_sender_for``, which reads the Agent row and uses its name. This module
is the outbound half, resolved from the same key by the same rule — so a channel
shows one identity for an agent, not one in Flowpad and another in Slack.

**Identity rides the SOURCE, not the message.** That is the existing precedent
(``cloud_email`` recovers its agent from ``source.config["agent_id"]``), and it
is why nothing here is threaded through ``IngestDriver.send``: that signature is
keyword-only with six implementations and no ``**kwargs``, so a new parameter
would touch every mail driver to serve one chat one. Resolving from the source
also covers ``DataSource.send`` — the SDK / ``blocks.Inbox`` path — which a value
carried on the reply target would have missed.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Optional

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class SenderIdentity:
    """The display identity a channel post is made under.

    A plain frozen dataclass, like ``ReplyTarget`` next door — NOT a
    ``DataSpec``. The repo's rule is that a shape which TRAVELS (a launch
    payload, a file header, an agent's input/output) is a spec; this value is
    built and consumed inside one process, never serialized, and registering a
    kind for it would also make the schema layer import the inbox layer.

    Both fields are the provider's vocabulary deliberately: Slack takes a
    ``username`` and an ``icon_emoji``, and a driver that cannot honour one
    simply ignores it. Empty means "say nothing" — never a placeholder, because
    a post under a made-up name is worse than a post under the app's own.
    """

    username: str = ""
    #: A Slack ``:shortcode:``, already colon-wrapped. Empty when the agent's
    #: avatar is not an emoji we can name — see ``emoji_shortcode``.
    icon_emoji: str = ""


#: Emoji character -> Slack shortcode.
#:
#: Slack's ``icon_emoji`` takes a ``:name:``, NOT the character, and its names
#: are Slack's own — not Unicode's, so `unicodedata.name()` cannot be used to
#: derive them. There is no shortcode data anywhere in this repo, so this is a
#: hand-written table covering the avatars our shipped agents actually use plus
#: the obvious neighbours. Anything absent yields no icon, which is the correct
#: degradation: Slack then shows the app's own icon.
_EMOJI_SHORTCODES: dict[str, str] = {
    "💬": ":speech_balloon:",
    "📬": ":mailbox_with_mail:",
    "📮": ":postbox:",
    "✉": ":envelope:",
    "🤖": ":robot_face:",
    "🧠": ":brain:",
    "🔍": ":mag:",
    "🔎": ":mag_right:",
    "📊": ":bar_chart:",
    "📝": ":memo:",
    "📦": ":package:",
    "🧹": ":broom:",
    "🔧": ":wrench:",
    "⚙": ":gear:",
    "🌐": ":globe_with_meridians:",
    "☁": ":cloud:",
    "🩺": ":stethoscope:",
    "⏫": ":arrow_double_up:",
    "🔀": ":twisted_rightwards_arrows:",
    "🚀": ":rocket:",
    "🛠": ":hammer_and_wrench:",
    "📈": ":chart_with_upwards_trend:",
    "🗂": ":card_index_dividers:",
    "🔔": ":bell:",
    "🧪": ":test_tube:",
}


def emoji_shortcode(avatar: Optional[str]) -> str:
    """The Slack shortcode for an agent's avatar, or ``""``.

    ``Agent.avatar`` is one string with four possible meanings — an emoji, a
    lucide icon name (``"Search"``), a repo icon path (``icons/agent.svg``), or
    the sentinel ``./avatar.png`` naming a file in the agent's own folder. Only
    the emoji can cross to Slack: an uploaded image is served from
    ``127.0.0.1`` behind auth, and Slack fetches ``icon_url`` from its own
    network, so there is nothing to point at. The other three yield ``""`` and
    the post carries a name but the app's icon.
    """
    # U+FE0F, the emoji variation selector, is invisible: "✉️" and "✉" render
    # identically and compare unequal. Storing both spellings would put two
    # pixel-identical rows in the table above and make "add a row" a guess.
    value = (avatar or "").strip().replace("\ufe0f", "")
    if not value:
        return ""
    return _EMOJI_SHORTCODES.get(value, "")


async def sender_identity(source: Any) -> Optional[SenderIdentity]:
    """The identity posts from ``source`` should carry, or ``None``.

    ``None`` — not an empty identity — whenever there is nothing to say: the
    source names no agent, the agent row is gone or unreadable, or the agent has
    neither a name nor a usable emoji. A caller then leaves its payload untouched
    rather than writing empty keys. The four cases are deliberately
    indistinguishable to the caller, which would act identically on all of them;
    only the debug log below tells them apart. Never raises: an unreadable Agent
    row costs a name, not a message.
    """
    from flow_sdk.inbox.projection import agent_id_of  # noqa: PLC0415

    agent_id = agent_id_of(source)
    if not agent_id:
        return None
    try:
        from flow_sdk.builtin.agent import Agent  # noqa: PLC0415

        agent = await Agent.get_by_id(agent_id)
    except Exception:  # noqa: BLE001 — identity is a nicety; sending is not
        logger.debug("[sender-identity] could not read agent %s", agent_id, exc_info=True)
        return None
    if agent is None:
        return None

    # `agent.name`, NOT `title` — `_agent_sender_for` (projection.py:498) names the
    # INBOUND half with `name`, and this module exists to make both halves agree.
    # Preferring `title` here would show one name in Flowpad and another in Slack
    # for any agent that has both, which is the exact failure this prevents.
    name = str(getattr(agent, "name", "") or "").strip()
    icon = emoji_shortcode(getattr(agent, "avatar", None))
    return SenderIdentity(username=name, icon_emoji=icon) if (name or icon) else None
