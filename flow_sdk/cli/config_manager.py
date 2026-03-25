#!/usr/bin/env python3

from platformdirs import user_config_dir
from enum import Enum
import json
import os

config_dir = user_config_dir("flow-cli")
os.makedirs(config_dir, exist_ok=True)
config_file = os.path.join(config_dir, "config.json")


class ConfigKey(Enum):
    """Enumerated config keys with their default values."""
    FLOWPAD_API_SERVER_HOST = "localhost:8000"
    LOGIN_URL = "localhost:5173"
    POST_LOGIN_TIMEOUT = "30"


def load_config():
    """Load all config key-value pairs from config.json."""
    if not os.path.exists(config_file):
        return {}
    try:
        with open(config_file) as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return {}


def save_config(config_dict):
    """Save config dictionary to config.json."""
    with open(config_file, "w") as f:
        json.dump(config_dict, f, indent=2)


def get_config_value(key):
    """Get a specific config value by key."""
    config = load_config()
    return config.get(key)


def set_config_value(key, value):
    """Set a config key-value pair."""
    config = load_config()
    config[key] = value
    save_config(config)


def remove_config_value(key):
    """Remove a config key."""
    config = load_config()
    if key in config:
        del config[key]
        save_config(config)
        return True
    return False


def list_config():
    """List all config key-value pairs."""
    return load_config()


def setup_defaults():
    """
    Setup default config key-value pairs.
    Only sets defaults for keys that don't already exist.
    """
    config = load_config()
    defaults_set = []

    for key in ConfigKey:
        key_name = key.name.lower()
        if key_name not in config:
            config[key_name] = key.value
            defaults_set.append(key_name)

    if defaults_set:
        save_config(config)

    return defaults_set
