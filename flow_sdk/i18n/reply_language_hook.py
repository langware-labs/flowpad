"""Remind the model, beside every user message, which language to reply in.

The language rule lives in the system prompt (``instructions/common_ui.md``), at
the far start of the context. In a long session the model sees mostly its own
earlier replies, tool output and reasoning — all English — and one English
message from the user flips the rest of the session to English. Run as a Claude
``UserPromptSubmit`` hook (``python -m flow_sdk.i18n.reply_language_hook``), its
stdout lands next to the message it is about. It is a bare module, not a ``flow``
subcommand, because it runs on every message and the CLI's startup costs ~1s.
"""

from __future__ import annotations

import sys

REMINDER = (
    "Reply in the language most of the user's message above is written in — every word they see. "
    "English technical terms, code, paths, names and quoted text in it do not count. "
    "If it has no natural-language sentence, keep the language of the conversation so far."
)


if __name__ == "__main__":
    sys.stdout.write(REMINDER + "\n")
