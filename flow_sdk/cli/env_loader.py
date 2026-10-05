#!/usr/bin/env python3
"""
Environment variable loader for flow CLI.
Loads environment variables from .env.local file using python-dotenv.
"""

import os

from dotenv import load_dotenv, find_dotenv


def cli_init():
    """
    Initialize the CLI by loading environment variables.
    This should be called as the first step when the CLI starts.

    Loads variables from .env.local in the project root, then builds the
    per-instance settings singleton so all subsequent path lookups go through
    InstanceSettings (single source of truth for dev vs prod vs test).
    """
    # FLOWPAD_SKIP_DOTENV: the process was handed its whole environment (a hub's local node, an
    # isolated test instance). ``find_dotenv`` searches from THIS file, so on an editable install it
    # finds the checkout's .env.local whatever the cwd -- and would fill every name the launcher
    # deliberately left out (a cloud login, channel tokens) with the developer's own values.
    if os.environ.get("FLOWPAD_SKIP_DOTENV", "").lower() != "true":
        _env_name = os.getenv(key="ENV", default=".env.local")
        load_dotenv(dotenv_path=find_dotenv(_env_name))

    # Build the per-instance settings singleton now that env is loaded.
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    get_instance_settings()
