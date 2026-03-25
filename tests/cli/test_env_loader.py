#!/usr/bin/env python3
"""
Tests for environment variable loading.
"""

import os
import pytest
from pathlib import Path
from flow_sdk.cli.env_loader import cli_init


def test_env_loader(tmp_path, monkeypatch):
    """
    Test that cli_init loads environment variables from .env.local
    """
    # Create a temp .env.local so the test is self-contained
    env_file = tmp_path / ".env.local"
    env_file.write_text("FOO=BAR\n")

    monkeypatch.delenv("FOO", raising=False)

    # Verify FOO is not set before loading
    assert os.environ.get('FOO') is None, "FOO should not be set before cli_init"

    # Patch find_dotenv to return our isolated temp file (find_dotenv searches
    # from the calling module's directory, not cwd, so chdir alone won't work)
    monkeypatch.setattr("flow_sdk.cli.env_loader.find_dotenv", lambda *a, **kw: str(env_file))

    # Call cli_init to load .env.local
    cli_init()

    # Verify FOO is now set to BAR
    assert os.environ.get('FOO') == 'BAR', f"Expected FOO=BAR, got FOO={os.environ.get('FOO')}"

    print(f"✅ Environment variable loaded: FOO={os.environ.get('FOO')}")


