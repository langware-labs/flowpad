"""Dependency-free reader/writer for lingui's .po catalogs (the subset they emit).

Shared by scan.py and apply.py. Handles multi-line `msgid`/`msgstr`, `#:` source
references and extracted (`#.`) comments, skips obsolete (`#~`) entries and the
header (`msgid ""`). It deliberately does NOT support `msgctxt` or plural
(`msgid_plural` / `msgstr[n]`) forms — lingui does not emit them for these
catalogs; such entries would be ignored, so do not point this at a hand-authored
plural catalog. It never re-serializes the whole file — apply.py does surgical,
per-entry msgstr replacement so lingui's formatting (sort order, wrapping) is
preserved.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field


def unescape(s: str) -> str:
    return (
        s.replace("\\n", "\n")
        .replace('\\"', '"')
        .replace("\\t", "\t")
        .replace("\\\\", "\\")
    )


def escape(s: str) -> str:
    return (
        s.replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("\n", "\\n")
        .replace("\t", "\\t")
    )


_QUOTED = re.compile(r'^\s*"(.*)"\s*$')


@dataclass
class Entry:
    msgid: str
    msgstr: str
    refs: list[str] = field(default_factory=list)      # `#:` source references
    comments: list[str] = field(default_factory=list)  # `#.` extracted comments
    start: int = 0   # line index (0-based) of first line of the block
    end: int = 0     # line index (exclusive) after the last line of the block


def parse(text: str) -> tuple[list[str], list[Entry]]:
    """Return (lines, entries). Entries exclude the header and obsolete blocks."""
    lines = text.split("\n")
    entries: list[Entry] = []
    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]
        if not line.strip() or line.startswith("#~"):
            i += 1
            continue
        if not (line.startswith("#") or line.startswith("msgid")):
            i += 1
            continue
        # Collect any leading comment block, then require the msgid it precedes.
        start = i
        refs, comments = [], []
        while i < n and lines[i].startswith("#") and not lines[i].startswith("#~"):
            if lines[i].startswith("#:"):
                refs.append(lines[i][2:].strip())
            elif lines[i].startswith("#."):
                comments.append(lines[i][2:].strip())
            i += 1
        if i >= n or not lines[i].startswith("msgid"):
            continue
        i, entry = _read_pair(lines, i, start, refs, comments)
        if entry and entry.msgid != "":  # drop the `msgid ""` header
            entries.append(entry)
    return lines, entries


def _read_string(lines: list[str], i: int) -> tuple[int, str]:
    """Read a `keyword "..."` line plus continuation `"..."` lines."""
    first = lines[i]
    m = re.match(r'^\w+\s+"(.*)"\s*$', first)
    parts = [m.group(1)] if m else [""]
    i += 1
    while i < len(lines):
        cm = _QUOTED.match(lines[i])
        if not cm:
            break
        parts.append(cm.group(1))
        i += 1
    return i, unescape("".join(parts))


def _read_pair(lines, i, start, refs, comments) -> tuple[int, Entry | None]:
    if not lines[i].startswith("msgid"):
        return i + 1, None
    i, msgid = _read_string(lines, i)
    if i >= len(lines) or not lines[i].startswith("msgstr"):
        return i, None
    msgstr_start = i
    i, msgstr = _read_string(lines, i)
    return i, Entry(msgid, msgstr, refs, comments, start, i)
