"""The emoji a Telegram bot may put on a message.

A bot reacts only with the Bot API's fixed set (``ReactionTypeEmoji``); anything else is refused by
Telegram, so ``react`` refuses it first, by name. The set is spelled the way Telegram spells it — no
variation selector — and a caller's ``❤️`` is the same reaction as ``❤``: ``normalize_emoji`` strips U+FE0F
from both sides before they are compared.
"""
from __future__ import annotations

from flow_sdk.sources.files import normalize_emoji

#: Bot API ``ReactionTypeEmoji.emoji`` — every reaction a bot can set.
ALLOWED_EMOJI: frozenset[str] = frozenset(normalize_emoji(e) for e in (
    "❤", "👍", "👎", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱", "🤬", "😢", "🎉", "🤩", "🤮", "💩", "🙏", "👌",
    "🕊", "🤡", "🥱", "🥴", "😍", "🐳", "❤‍🔥", "🌚", "🌭", "💯", "🤣", "⚡", "🍌", "🏆", "💔", "🤨", "😐", "🍓",
    "🍾", "💋", "🖕", "😈", "😴", "😭", "🤓", "👻", "👨‍💻", "👀", "🎃", "🙈", "😇", "😨", "🤝", "✍", "🤗", "🫡",
    "🎅", "🎄", "☃", "💅", "🤪", "🗿", "🆒", "💘", "🙉", "🦄", "😘", "💊", "🙊", "😎", "👾", "🤷‍♂", "🤷", "🤷‍♀",
    "😡",
))


__all__ = ["ALLOWED_EMOJI"]
