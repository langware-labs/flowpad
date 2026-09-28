"""Slack names an emoji (``thumbsup``, ``+1``, ``thumbsup::skin-tone-3``); the contract carries unicode.

``emoji_names.json`` is the table, name → unicode. Several names can share one glyph; the FIRST name
listed for a glyph is the one we send (Slack's own canonical, ``+1`` before ``thumbsup``). Glyphs are
compared without U+FE0F, the variation selector a keyboard may or may not type (``❤`` vs ``❤️``).

A name the table does not hold travels inbound as ``:name:`` (a workspace's custom emoji has no
unicode form at all) and is sent back as that name; unicode the table does not hold is refused —
never a substitute.
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Optional

from flow_sdk.sources.files import normalize_emoji

#: Slack's ``::skin-tone-N`` suffix, N = 2..6, and the Fitzpatrick modifier each one is.
_TONES = {str(n): chr(0x1F3FB + n - 2) for n in range(2, 7)}
_TONE_OF = {glyph: n for n, glyph in _TONES.items()}


@lru_cache(maxsize=1)
def _tables() -> tuple[dict[str, str], dict[str, str]]:
    names: dict[str, str] = json.loads((Path(__file__).parent / "emoji_names.json").read_text(encoding="utf-8"))
    glyphs: dict[str, str] = {}
    for name, glyph in names.items():
        glyphs.setdefault(normalize_emoji(glyph), name)
    return names, glyphs


def unicode_of(name: str) -> str:
    """The glyph a Slack reaction name shows, or ``:name:`` when it has none we know."""
    base, _, tone = name.partition("::skin-tone-")
    glyph = _tables()[0].get(base)
    if glyph is None:
        return f":{name}:"
    return glyph + _TONES.get(tone, "")


def name_of(emoji: str) -> Optional[str]:
    """The Slack name for a glyph (or a ``:name:``), ``None`` when Slack has none we know."""
    emoji = (emoji or "").strip()
    if len(emoji) > 2 and emoji.startswith(":") and emoji.endswith(":"):
        return emoji[1:-1]
    tone = _TONE_OF.get(emoji[-1:]) if emoji else None
    base = emoji[:-1] if tone else emoji
    name = _tables()[1].get(normalize_emoji(base))
    if name is None:
        return None
    return f"{name}::skin-tone-{tone}" if tone else name


__all__ = ["name_of", "unicode_of"]
