"""An agent's ``disallowed_tools``, enforced on the deepagents backend.

Claude enforces the rules in its own CLI. deepagents has no such list, so the runner wraps
its shell-and-files backend instead: ``Bash(<prefix>:*)`` refuses any command whose step
starts with ``<prefix>``, and ``Write`` / ``Edit`` / ``MultiEdit`` refuse writing files.
A refused call returns an error to the model; nothing runs.
"""

from __future__ import annotations

import re
from typing import Any

#: Where one shell command ends and the next one starts: ``a && b``, ``a; b``, ``a | b``, newlines.
_STEPS = re.compile(r"&&|\|\||[;|\n&]|\$\(|`")
_BASH_RULE = re.compile(r"^Bash\((.+?)(?::\*)?\)$")
_WRITE_TOOLS = frozenset({"Write", "Edit", "MultiEdit", "NotebookEdit"})


def bash_prefixes(rules: list[str]) -> tuple[str, ...]:
    """The command prefixes ``Bash(<prefix>:*)`` rules deny."""
    return tuple(m.group(1).strip() for m in map(_BASH_RULE.match, rules) if m)


def denied_command(command: str, prefixes: tuple[str, ...]) -> str | None:
    """The rule that refuses ``command``, or ``None`` when it may run."""
    for step in _STEPS.split(command):
        words = " ".join(step.split())
        for prefix in prefixes:
            if words == prefix or words.startswith(prefix + " "):
                return f"Bash({prefix}:*)"
    return None


def banned_backend(backend_cls: type, rules: list[str], **kwargs: Any):
    """``backend_cls(**kwargs)``, refusing what ``rules`` deny. The plain backend when nothing is denied."""
    prefixes = bash_prefixes(rules)
    no_writes = bool(_WRITE_TOOLS & set(rules))
    if not prefixes and not no_writes:
        return backend_cls(**kwargs)
    from deepagents.backends.protocol import EditResult, ExecuteResponse, WriteResult  # noqa: PLC0415

    class Banned(backend_cls):
        def execute(self, command: str, **kw: Any):
            rule = denied_command(command, prefixes) if prefixes else None
            if rule:
                return ExecuteResponse(output=f"Refused: this agent may not run {rule}.", exit_code=1)
            return super().execute(command, **kw)

        def write(self, file_path: str, *args: Any, **kw: Any):
            if no_writes:
                return WriteResult(error=f"Refused: this agent may not write files ({file_path}).")
            return super().write(file_path, *args, **kw)

        def edit(self, file_path: str, *args: Any, **kw: Any):
            if no_writes:
                return EditResult(error=f"Refused: this agent may not edit files ({file_path}).")
            return super().edit(file_path, *args, **kw)

    return Banned(**kwargs)
