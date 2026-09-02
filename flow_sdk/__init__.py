"""Flow SDK Python package."""

from flow_sdk import auth as auth
from flow_sdk._version import __version__
from flow_sdk.auth import LoginRequired
from flow_sdk.claude_env import ClaudeProjectEnvManager

version = __version__

__all__ = [
    "fs_records",
    "fs_store",
    "utils",
    "discovery",
    "auth",
    "LoginRequired",
    "version",
    "ClaudeProjectEnvManager",
]
