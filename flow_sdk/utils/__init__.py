"""Shared utilities. Each name loads its own module on first use (PEP 562): importing ``flow_sdk.utils`` -- which
any ``flow_sdk.utils.<x>`` import does -- used to pull FastAPI, httpx and every other utility in, about 8 s of a
CLI start on a slow Windows box, for a command that needed one environment helper."""

from importlib import import_module
from typing import Any

_WHERE = {
    "CommandExecutor": "command_executor",
    "AsyncEventEmitter": "concurrency",
    "filter_none_from_list": "concurrency",
    "read_files_in_parallel": "concurrency",
    "recommended_concurrency_limit": "concurrency",
    "get_bool_env_var": "environment",
    "get_float_env_var": "environment",
    "get_int_env_var": "environment",
    "get_str_list_env_var": "environment",
    "ROOT_FOLDER": "file_system",
    "_get_builtin_folder": "file_system",
    "_get_flowpad_folder": "file_system",
    "_get_hub_folder": "file_system",
    "_get_plugins_folder": "file_system",
    "cwd_as_folder": "file_system",
    "cwd_as_root_folder": "file_system",
    "get_instances_folder": "file_system",
    "get_manifest_folder": "file_system",
    "git_commit_hash": "git",
    "git_root_folder": "git",
    "file_hash": "hashing",
    "hash_password": "hashing",
    "fetch_json": "networking",
    "fetch_url": "networking",
    "global_httpx_async_client": "networking",
    "is_url": "networking",
    "iso_to_datetime": "serialization",
    "starlett_query_brackets_to_dict": "serialization",
    "type_safe_json": "serialization",
    "type_safe_json_dumps": "serialization",
    "count_tokens": "text",
    "sanitize_filename": "text",
    "sanitize_for_logging": "text",
    "sync_count_tokens": "text",
    "TimeIt": "timeit",
    "validate_schema_on_data": "validation",
}


def __getattr__(name: str) -> Any:
    module = _WHERE.get(name)
    if module is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    value = getattr(import_module(f".{module}", __name__), name)
    globals()[name] = value
    return value


__all__ = [
    # Command execution
    "CommandExecutor",
    # Concurrency
    "AsyncEventEmitter",
    "filter_none_from_list",
    "read_files_in_parallel",
    "recommended_concurrency_limit",
    # Environment
    "get_bool_env_var",
    "get_float_env_var",
    "get_int_env_var",
    "get_str_list_env_var",
    # File system
    "ROOT_FOLDER",
    "_get_builtin_folder",
    "_get_flowpad_folder",
    "_get_hub_folder",
    "_get_plugins_folder",
    "cwd_as_folder",
    "cwd_as_root_folder",
    "get_instances_folder",
    "get_manifest_folder",
    # Git
    "git_commit_hash",
    "git_root_folder",
    # Hashing
    "file_hash",
    "hash_password",
    # Networking
    "fetch_json",
    "fetch_url",
    "global_httpx_async_client",
    "is_url",
    # Serialization
    "iso_to_datetime",
    "starlett_query_brackets_to_dict",
    "type_safe_json",
    "type_safe_json_dumps",
    # Text
    "count_tokens",
    "sanitize_filename",
    "sanitize_for_logging",
    "sync_count_tokens",
    # Timing
    "TimeIt",
    # Validation
    "validate_schema_on_data",
]
