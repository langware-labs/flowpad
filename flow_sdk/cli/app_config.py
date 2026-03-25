#!/usr/bin/env python3
"""
Application configuration module for flow CLI.
Manages user configuration in a JSON file using platformdirs.
"""

from platformdirs import user_config_dir
from pathlib import Path
import json
from typing import Any


# Initialize config directory and file path
_config_dir = Path(user_config_dir("flow-cli"))
_config_dir.mkdir(parents=True, exist_ok=True)
config_file_path = _config_dir / "config.json"


def _load_config() -> dict:
    """Load the configuration from the JSON file."""
    if not config_file_path.exists():
        return {}

    try:
        with open(config_file_path, 'r') as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return {}


def _save_config(config: dict) -> None:
    """Save the configuration to the JSON file."""
    with open(config_file_path, 'w') as f:
        json.dump(config, f, indent=2)


def set_config(key: str, value: Any) -> None:
    """
    Set a configuration value.

    Supports native Python types (str, int, float, bool) and complex types
    (dict, list) which will be stored as JSON.

    Args:
        key: Configuration key
        value: Configuration value (will be JSON serialized if complex type)
    """
    config = _load_config()

    # Store the value directly - json.dump will handle serialization
    config[key] = value

    _save_config(config)


def get_config(key: str, default: Any = None) -> Any:
    """
    Get a configuration value.

    Args:
        key: Configuration key
        default: Default value if key doesn't exist

    Returns:
        The configuration value, or default if not found
    """
    config = _load_config()
    return config.get(key, default)


def get_user() -> dict | None:
    """
    Get the stored user information.

    Returns:
        dict | None: User information dictionary, or None if not logged in
    """
    return get_config('user')


def set_user(user_info: dict) -> None:
    """
    Store user information.

    Args:
        user_info: User information dictionary (will be stored as JSON)
    """
    set_config('user', user_info)


def clear_user() -> None:
    """
    Clear stored user information.
    """
    config = _load_config()
    if 'user' in config:
        del config['user']
        _save_config(config)
