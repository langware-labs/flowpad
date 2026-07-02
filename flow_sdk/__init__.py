"""Flow SDK Python package.

The package init is LAZY (PEP 562): importing ``flow_sdk`` must stay cheap
because EVERY Python process pays it — each ``flow`` CLI invocation, the
monitor process, the server, and every agentic worker's ``flow record/...``
call. The eager version imported ``flow_sdk.config`` (which drags in
pydantic + fastapi/httpx via ``flow_sdk.utils``) — ~1s of interpreter
startup before a single line of command code ran.

``from flow_sdk import ClaudeProjectEnvManager`` / ``UI_DIST`` and attribute
access like ``flow_sdk.config`` still work exactly as before — they resolve
on first use via ``__getattr__``. Do NOT add eager imports back here; put
them in the module that actually needs them.
"""

from typing import TYPE_CHECKING

from flow_sdk._version import __version__

if TYPE_CHECKING:
    # Static-analysis only (PyCharm / mypy): give the lazy re-exports real
    # definitions. Never executed at runtime — laziness is preserved.
    from flow_sdk.claude_env import ClaudeProjectEnvManager
    from flow_sdk.config import UI_DIST

version = __version__

__all__ = [
    "fs_records",
    "fs_store",
    "hooks",
    "utils",
    "discovery",
    "version",
    "ClaudeProjectEnvManager",
    "UI_DIST",
]

# Re-exported symbols, resolved on first access.
_LAZY_ATTRS: dict[str, tuple[str, str]] = {
    "ClaudeProjectEnvManager": ("flow_sdk.claude_env", "ClaudeProjectEnvManager"),
    "UI_DIST": ("flow_sdk.config", "UI_DIST"),
}


def __getattr__(name: str):
    import importlib

    if name in _LAZY_ATTRS:
        module_path, attr = _LAZY_ATTRS[name]
        value = getattr(importlib.import_module(module_path), attr)
        globals()[name] = value  # cache — __getattr__ won't be called again
        return value
    # Submodule fallback: with the eager init, ``import flow_sdk`` made
    # ``flow_sdk.claude_env`` / ``flow_sdk.config`` reachable as attributes
    # (import side effect). Keep that working without the eager cost.
    try:
        return importlib.import_module(f"{__name__}.{name}")
    except ModuleNotFoundError as exc:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}") from exc
