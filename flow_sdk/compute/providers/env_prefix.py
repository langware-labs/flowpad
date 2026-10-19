"""Convert named environment values for command execution.

Providers use ``command_environment`` with their native environment API so
secrets never enter command strings, logs, or process arguments. Shell-only
callers can still use ``build_env_prefix`` with the shared escaping rules.
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

    Windows: ``set "NAME=value" && `` — the quotes are not cosmetic. ``set`` is a
    STATEMENT, not an assignment prefix, and it takes the rest of the statement
    verbatim: the unquoted ``set NAME=value && `` assigns ``"value "``, separator
    space included. The closing quote is what terminates the value. cmd treats
    ``& | < > ^`` literally inside it, so they must NOT also be caret-escaped —
    that would put literal carets in the value.
    """
    pairs = _pairs(env)
    if not pairs:
        return ""

    on_windows = (sys.platform == PLATFORM_WIN32) if windows is None else windows
    if on_windows:
        return " && ".join(f'set "{name}={value}"' for name, value in pairs) + " && "
    return " ".join(f"{name}={_quote_posix(value)}" for name, value in pairs) + " "


def _quote_posix(value: str) -> str:
    """Wrap in single quotes, closing/escaping/reopening around any it contains."""
    return "'" + value.replace("'", "'\\''") + "'"


def command_environment(env: Iterable[Any] | None) -> dict[str, str]:
    """Unwrap the command overlay for a provider's native environment API."""
    return dict(_pairs(env))
