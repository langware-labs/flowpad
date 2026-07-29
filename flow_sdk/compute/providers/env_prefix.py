"""Build the ``VAR='value' `` prefix that carries env vars into one command.

Every compute provider injects env the same way the hub does: by prefixing
assignments onto the shell command, so the values live for exactly one process
and are never written to the node's filesystem. (``set_env`` is the other,
deliberately-persistent path — it is for the ``FLOWPAD_*`` proxy config, never
for project secrets.)

Each provider used to hand-roll this, which is how the E2B copy drifted into
taking a ``dict`` while every caller passes ``list[FlowEnv]``. One builder,
one escaping rule, one place to test.

**The value never appears in a log line.** Callers log the bare ``command``;
the prefix is joined on immediately before handing the string to the shell.
"""

from __future__ import annotations

import sys
from typing import Any, Iterable

from flow_sdk.config import PLATFORM_WIN32


def _unwrap(value: Any) -> str:
    """``SecretStr`` -> ``str``, anything else -> ``str``.

    ``FlowEnv.value`` is a ``SecretStr``; ``str()`` on one yields
    ``'**********'``, so unwrapping explicitly is what keeps the real value
    from being silently replaced by asterisks.
    """
    if hasattr(value, "get_secret_value"):
        return value.get_secret_value()
    return "" if value is None else str(value)


def _pairs(env: Iterable[Any] | None) -> list[tuple[str, str]]:
    """``list[FlowEnv]`` -> ``(name, value)`` pairs.

    Deliberately does NOT accept a mapping: the dict shape was the bug this
    module exists to remove, and every provider signature now says list.
    """
    if not env:
        return []
    out: list[tuple[str, str]] = []
    for item in env:
        name = getattr(item, "name", None)
        if not name:
            continue
        out.append((str(name), _unwrap(getattr(item, "value", ""))))
    return out


def build_env_prefix(env: Iterable[Any] | None, *, windows: bool | None = None) -> str:
    """The prefix to prepend to a command, or ``""`` when there is nothing to set.

    POSIX: ``NAME='value' `` — single-quoted, with embedded single quotes
    closed-escaped-reopened (``'\\''``), which is the only sequence that is
    safe for arbitrary bytes inside single quotes.

    Windows: ``set NAME=value && `` — ``cmd.exe`` has no single-quote literal,
    so shell metacharacters are caret-escaped instead.
    """
    pairs = _pairs(env)
    if not pairs:
        return ""

    on_windows = (sys.platform == PLATFORM_WIN32) if windows is None else windows
    if on_windows:
        return " && ".join(f"set {name}={_escape_windows(value)}" for name, value in pairs) + " && "
    return " ".join(f"{name}={_quote_posix(value)}" for name, value in pairs) + " "


def _quote_posix(value: str) -> str:
    """Wrap in single quotes, closing/escaping/reopening around any it contains."""
    return "'" + value.replace("'", "'\\''") + "'"


def _escape_windows(value: str) -> str:
    # ``^`` first — escaping it last would double-escape the carets the other
    # replacements just introduced.
    return (
        value.replace("^", "^^")
        .replace("&", "^&")
        .replace("|", "^|")
        .replace("<", "^<")
        .replace(">", "^>")
    )
