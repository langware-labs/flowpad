"""The emoji a Telegram bot may put on a message.

A bot reacts only with the Bot API's fixed set (``ReactionTypeEmoji``); anything else is refused by
Telegram, so ``react`` refuses it first, by name. The set is spelled the way Telegram spells it — no
variation selector — and a caller's ``❤️`` is the same reaction as ``❤``: ``normalize`` strips U+FE0F
from both sides before they are compared.
"""
from __future__ import annotations

_VS16 = "️"


def normalize(emoji: str) -> str:
    """``emoji`` without its variation selectors — the form Telegram lists and accepts."""
    return str(emoji or "").replace(_VS16, "").strip()


#: Bot API ``ReactionTypeEmoji.emoji`` — every reaction a bot can set.
ALLOWED_EMOJI: frozenset[str] = frozenset(normalize(e) for e in (
    "❤", "👍", "👎", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱", "🤬", "😢", "🎉", "🤩", "🤮", "💩", "🙏", "👌",
    "🕊", "🤡", "🥱", "🥴", "😍", "🐳", "❤‍🔥", "🌚", "🌭", "💯", "🤣", "⚡", "🍌", "🏆", "💔", "🤨", "😐", "🍓",
    "🍾", "💋", "🖕", "😈", "😴", "😭", "🤓", "👻", "👨‍💻", "👀", "🎃", "🙈", "😇", "😨", "🤝", "✍", "🤗", "🫡",
    "🎅", "🎄", "☃", "💅", "🤪", "🗿", "🆒", "💘", "🙉", "🦄", "😘", "💊", "🙊", "😎", "👾", "🤷‍♂", "🤷", "🤷‍♀",
    "😡",
))


__all__ = ["ALLOWED_EMOJI", "normalize"]
