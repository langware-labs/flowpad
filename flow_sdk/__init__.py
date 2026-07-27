"""Flow SDK Python package."""

from flow_sdk._version import __version__
from flow_sdk.claude_env import ClaudeProjectEnvManager

version = __version__

__all__ = [
    "fs_records",
    "fs_store",
    "hooks",
    "utils",
    "discovery",
    "version",
    "ClaudeProjectEnvManager",
]
