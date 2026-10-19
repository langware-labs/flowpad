"""Which vendor tool means what — the per-worker part, as data.

The only genuinely vendor-specific thing about a semantic entry is the *name*
the vendor gave the tool and the *keys* it used in the arguments. Everything
else — what a search entry is, what fields it carries, how it renders — is
shared. Keeping the vendor part as a table means adding a tool is a row, and a
worker missing a capability is a visible gap rather than silence.

This is the file that fixes the asymmetry the codebase had: semantic kinds were
implemented once per parser, so ``SearchEntry`` existed only for claude and
``ExitPlanModeEntry`` did not exist for copilot — not decisions, just gaps.
"""

from __future__ import annotations

#: Semantic keys. Deliberately not ``EntryKind`` values: several vendor tools
#: collapse onto one kind (``Glob`` and ``Grep`` are both ``search``), and the
#: key is what the builder switches on.
SKILL_CALL = "skill_call"
EXIT_PLAN_MODE = "exit_plan_mode"
SEARCH = "search"
WEB_FETCH = "web_fetch"
TODO_UPDATE = "todo_update"
AGENT_SPAWN = "agent_spawn"
SHELL_COMMAND = "shell_command"
FILE_READ = "file_read"
FILE_WRITE = "file_write"
FILE_EDIT = "file_edit"

#: Exact tool name (lowercased) -> semantic key, shared by every worker.
#: Vendors converge on these more than they differ; a worker-specific entry
#: below overrides only where one genuinely diverges.
_COMMON: dict[str, str] = {
    "skill": SKILL_CALL,
    "exitplanmode": EXIT_PLAN_MODE,
    "exit_plan_mode": EXIT_PLAN_MODE,
    "update_plan": EXIT_PLAN_MODE,
    "glob": SEARCH,
    "grep": SEARCH,
    "search": SEARCH,
    "file_search": SEARCH,
    "grep_search": SEARCH,
    "webfetch": WEB_FETCH,
    "websearch": WEB_FETCH,
    "web_fetch": WEB_FETCH,
    "web_search": WEB_FETCH,
    "todowrite": TODO_UPDATE,
    "todo_write": TODO_UPDATE,
    "update_todo_list": TODO_UPDATE,
    "task": AGENT_SPAWN,
    "agent": AGENT_SPAWN,
    # Shell and file ops. Claude and copilot parsers already emit these as
    # physical entries, so nothing generic is left for the handler to refine
    # there; codex hands us `ToolUseEntry(tool_name="shell")` and got no shell
    # chip at all, which is the gap these rows close.
    "bash": SHELL_COMMAND,
    "shell": SHELL_COMMAND,
    "run_command": SHELL_COMMAND,
    "exec_command": SHELL_COMMAND,
    "terminal": SHELL_COMMAND,
    "read": FILE_READ,
    "notebookread": FILE_READ,
    "view_file": FILE_READ,
    "write": FILE_WRITE,
    "create_file": FILE_WRITE,
    "edit": FILE_EDIT,
    "multiedit": FILE_EDIT,
    "notebookedit": FILE_EDIT,
    "str_replace_editor": FILE_EDIT,
}

#: Per-worker overrides and additions. Empty today — every tool these six kinds
#: cover happens to be named consistently enough for ``_COMMON``. The dimension
#: exists because vendors WILL diverge, and the alternative is another parser
#: branch.
_BY_WORKER: dict[str, dict[str, str]] = {}


def semantic_key(worker: str, tool_name: str) -> str | None:
    """The semantic key for ``tool_name`` on ``worker``, or None if unrecognised.

    Unrecognised is the common, correct answer: MCP tools (``mcp__*``) and
    bespoke vendor tools stay generic ``ToolUseEntry`` rather than being forced
    into a shape they do not have.
    """
    name = (tool_name or "").strip().lower()
    if not name:
        return None
    return _BY_WORKER.get(worker, {}).get(name) or _COMMON.get(name)


#: Argument-key aliases. Vendors spell the same field differently
#: (``file_path`` / ``path`` / ``filePath`` / ``filename``); the builders read
#: through this rather than each guessing.
_ALIASES: dict[str, tuple[str, ...]] = {
    "path": ("file_path", "path", "filePath", "filename", "notebook_path"),
    "skill": ("skill", "name", "command"),
    "query": ("pattern", "query", "q"),
    "url": ("url", "uri"),
    "prompt": ("prompt", "instructions"),
    "todos": ("todos", "items", "todo_list"),
    "agent_type": ("subagent_type", "agent_type", "agent"),
    "description": ("description", "title"),
    "command": ("command", "cmd", "script"),
    "content": ("content", "file_text", "text", "new_str"),
    "old_string": ("old_string", "old_str"),
    "new_string": ("new_string", "new_str"),
}


def arg(tool_input: dict, field: str) -> str:
    """First non-empty value among ``field``'s aliases, as a string."""
    for key in _ALIASES.get(field, (field,)):
        value = tool_input.get(key)
        if value not in (None, ""):
            return str(value)
    return ""


def arg_list(tool_input: dict, field: str) -> list:
    for key in _ALIASES.get(field, (field,)):
        value = tool_input.get(key)
        if isinstance(value, list):
            return value
    return []
