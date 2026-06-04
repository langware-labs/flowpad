"""Line-level diff helpers — pure stdlib.

The UI renders diffs through ``DiffContent.tsx``, whose gitdiff-parser REQUIRES
git-style ``diff --git a/<rel> b/<rel>`` headers; plain ``difflib`` output (only
``---``/``+++``) parses to nothing. ``git_unified_diff`` wraps difflib output
with those headers. Newlines are normalized via ``splitlines()`` so CRLF↔LF
round-trips don't produce whole-file false diffs.
"""

from __future__ import annotations

import difflib

#: Files larger than this are not diffed (and not stored as blobs).
MAX_DIFF_BYTES = 2_000_000


def is_binary_bytes(data: bytes) -> bool:
    """Heuristic: NUL byte in the head — good enough for a docs vault."""
    return b"\0" in data[:8192]


def git_unified_diff(rel: str, old_text: str, new_text: str) -> str:
    """Unified diff of ``old_text`` → ``new_text`` with git-style headers.

    Returns "" when the (newline-normalized) sides are identical.
    """
    old_lines = old_text.splitlines()
    new_lines = new_text.splitlines()
    body = list(
        difflib.unified_diff(old_lines, new_lines, fromfile=f"a/{rel}", tofile=f"b/{rel}", lineterm="")
    )
    if not body:
        return ""
    return "\n".join([f"diff --git a/{rel} b/{rel}", *body]) + "\n"
