"""The subject fallback thread key: what an email threads by when its provider names no thread."""

from __future__ import annotations

import re

#: Reply/forward prefixes stripped when a provider gives us no native thread
#: handle and the subject is all we have. Deliberately multi-lingual: a
#: two-entry English list silently forks every non-English thread. Applied
#: repeatedly to a fixed point, so `Re: Fwd: RE:` collapses.
_SUBJECT_PREFIX = re.compile(
    r"^\s*(?:re|rif|aw|antw|sv|vs|vb|res|enc|tr|fwd?|wg|encaminhada|回复|答复|转发)\s*(?:\[\d+\])?\s*:\s*",
    re.IGNORECASE,
)
#: Bracketed list/banner tags: `[team]`, `[EXTERNAL]`.
_SUBJECT_TAG = re.compile(r"^\s*\[[^\]]{1,40}\]\s*")


def normalize_subject(subject: str) -> str:
    """A subject reduced to its threading key.

    The FALLBACK thread key — used only when the provider offers nothing
    better. Every channel worth supporting ships a native handle (Gmail
    ``threadId``, Slack ``thread_ts``, a Jira issue key) and the driver should
    put it in ``SourceItem.thread_key``; this is what happens when it can't.

    Known and accepted failure modes, documented so nobody rediscovers them as
    bugs: two unrelated ``Re: hello`` threads IN ONE MAILBOX collapse into one, and
    editing a subject mid-thread forks it. Both are why the native handle wins when
    it exists; the thread key is also scoped by channel, owner and the source that
    read it, so the collapse never crosses accounts.
    """
    text = (subject or "").strip()
    while True:
        stripped = _SUBJECT_TAG.sub("", _SUBJECT_PREFIX.sub("", text))
        if stripped == text:
            break
        text = stripped
    return " ".join(text.split()).casefold()


__all__ = ["normalize_subject"]
