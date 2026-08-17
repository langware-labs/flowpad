"""Pure serialization and quoting helpers for worker CLI arguments.

Structured values become one raw argv value here. Shell quoting is a separate
rendering concern so direct process spawns never receive shell syntax.
"""

from __future__ import annotations

import json
import math
import re
import shlex
from collections.abc import Mapping, Sequence
from typing import Any

_TOML_BARE_KEY = re.compile(r"[A-Za-z0-9_-]+\Z")
_POWERSHELL_SAFE_ARG = re.compile(r"[A-Za-z0-9_@%+=:,./-]+\Z")


def serialize_json_cli_value(value: Any) -> str:
    """Serialize *value* into one unquoted JSON argv slot."""
    return json.dumps(value, allow_nan=False)


def _serialize_toml_string(value: str) -> str:
    # JSON basic strings use the same escapes TOML accepts. Keep Unicode as
    # UTF-8, while escaping DEL explicitly because JSON permits it raw and TOML
    # does not.
    return json.dumps(value, ensure_ascii=False).replace("\x7f", "\\u007f")


def _serialize_toml_key(value: str) -> str:
    return value if _TOML_BARE_KEY.fullmatch(value) else _serialize_toml_string(value)


def serialize_toml_cli_value(value: Any) -> str:
    """Serialize a supported Python value as a compact TOML value.

    The result is raw TOML for a single CLI argv slot; callers add their own
    ``key=`` prefix and shell rendering later.
    """
    if isinstance(value, str):
        return _serialize_toml_string(value)
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("TOML CLI values require finite floats")
        return repr(value)
    if isinstance(value, list):
        return "[" + ",".join(serialize_toml_cli_value(item) for item in value) + "]"
    if isinstance(value, Mapping):
        if not all(isinstance(key, str) for key in value):
            raise TypeError("TOML CLI mapping keys must be strings")
        entries = (f"{_serialize_toml_key(key)}={serialize_toml_cli_value(item)}" for key, item in value.items())
        return "{" + ",".join(entries) + "}"
    raise TypeError(f"Unsupported TOML CLI value: {type(value).__name__}")


def quote_powershell_literal(value: str) -> str:
    """Return an always-quoted PowerShell single-string literal."""
    return "'" + value.replace("'", "''") + "'"


def quote_shell_arg(value: str, platform: str) -> str:
    """Quote one argv value for a POSIX shell or PowerShell command."""
    if platform != "win32":
        return shlex.quote(value)
    if _POWERSHELL_SAFE_ARG.fullmatch(value):
        return value
    return quote_powershell_literal(value)


def render_shell_command(argv: Sequence[str], platform: str) -> str:
    """Render raw argv as one POSIX-shell or PowerShell command string.

    Each item is quoted exactly once. Callers must pass the original argv,
    never a command string that has already been shell-rendered.
    """
    return " ".join(quote_shell_arg(value, platform) for value in argv)
