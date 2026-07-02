# All public names are LAZY (PEP 562). Importing ANY utils submodule (e.g.
# flow_sdk.utils.validation, pulled in by flow_sdk.config and therefore by
# every `flow` CLI call, the monitor process, and every worker) executes this
# package init — and the eager version imported networking (httpx) and
# serialization (fastapi.encoders) on the spot: ~0.7s of interpreter startup
# for processes that never touch them. `from flow_sdk.utils import X` still
# works for every name below; it just resolves on first access.
# Do NOT add eager imports back here.

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    # Static-analysis only (PyCharm / mypy): give the lazy names real
    # definitions. Never executed at runtime — laziness is preserved.
    from .concurrency import (
        AsyncEventEmitter,
        filter_none_from_list,
        read_files_in_parallel,
        recommended_concurrency_limit,
    )
    from .environment import (
        get_bool_env_var,
        get_float_env_var,
        get_int_env_var,
        get_str_list_env_var,
    )
    from .file_system import (
        ROOT_FOLDER,
        _get_builtin_folder,
        _get_flowpad_folder,
        _get_hub_folder,
        _get_plugins_folder,
        cwd_as_folder,
        cwd_as_root_folder,
        get_instances_folder,
        get_manifest_folder,
    )
    from .git import git_commit_hash, git_root_folder
    from .hashing import file_hash, hash_password
    from .networking import fetch_json, fetch_url, global_httpx_async_client, is_url
    from .serialization import (
        iso_to_datetime,
        starlett_query_brackets_to_dict,
        type_safe_json,
        type_safe_json_dumps,
    )
    from .text import count_tokens, sanitize_filename, sanitize_for_logging, sync_count_tokens
    from .timeit import TimeIt
    from .validation import validate_schema_on_data

__all__ = [
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

# name → defining submodule (relative to this package)
_LAZY_MAP: dict[str, str] = {
    "AsyncEventEmitter": ".concurrency",
    "filter_none_from_list": ".concurrency",
    "read_files_in_parallel": ".concurrency",
    "recommended_concurrency_limit": ".concurrency",
    "get_bool_env_var": ".environment",
    "get_float_env_var": ".environment",
    "get_int_env_var": ".environment",
    "get_str_list_env_var": ".environment",
    "ROOT_FOLDER": ".file_system",
    "_get_builtin_folder": ".file_system",
    "_get_flowpad_folder": ".file_system",
    "_get_hub_folder": ".file_system",
    "_get_plugins_folder": ".file_system",
    "cwd_as_folder": ".file_system",
    "cwd_as_root_folder": ".file_system",
    "get_instances_folder": ".file_system",
    "get_manifest_folder": ".file_system",
    "git_commit_hash": ".git",
    "git_root_folder": ".git",
    "file_hash": ".hashing",
    "hash_password": ".hashing",
    "fetch_json": ".networking",
    "fetch_url": ".networking",
    "global_httpx_async_client": ".networking",
    "is_url": ".networking",
    "iso_to_datetime": ".serialization",
    "starlett_query_brackets_to_dict": ".serialization",
    "type_safe_json": ".serialization",
    "type_safe_json_dumps": ".serialization",
    "count_tokens": ".text",
    "sanitize_filename": ".text",
    "sanitize_for_logging": ".text",
    "sync_count_tokens": ".text",
    "TimeIt": ".timeit",
    "validate_schema_on_data": ".validation",
}


def __getattr__(name: str):
    import importlib

    module_path = _LAZY_MAP.get(name)
    if module_path is not None:
        value = getattr(importlib.import_module(module_path, __name__), name)
        globals()[name] = value  # cache — __getattr__ won't be called again
        return value
    # Submodule fallback: the eager init made `flow_sdk.utils.networking` etc.
    # reachable as attributes (import side effect). Keep that working.
    try:
        return importlib.import_module(f".{name}", __name__)
    except ModuleNotFoundError as exc:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}") from exc


def __dir__():
    return sorted(set(globals()) | set(_LAZY_MAP))
