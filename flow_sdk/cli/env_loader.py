#!/usr/bin/env python3
"""
Environment variable loader for flow CLI.
Loads environment variables from .env.local file using python-dotenv.
"""

import os
from pathlib import Path
from urllib.parse import quote
from dotenv import load_dotenv, find_dotenv


def cli_init():
    """
    Initialize the CLI by loading environment variables.
    This should be called as the first step when the CLI starts.

    Loads variables from .env.local in the project root.
    """
    _env_name = os.getenv(key="ENV", default=".env.local")
    _env_file = find_dotenv(_env_name)

    # Load environment variables from .env.local
    load_dotenv(dotenv_path=_env_file)


def get_login_url(redirect_url: str) -> str:
    """
    Get the login URL with the redirect URL properly formatted.

    Reads API_BASE_URL and LOGIN_URL from environment variables, combines them,
    and replaces {redirect_url} with the URL-encoded redirect URL.

    Args:
        redirect_url: The redirect URL to include in the login URL

    Returns:
        The formatted login URL with the redirect URL encoded

    Example:
        If API_BASE_URL = "http://localhost:8000/api/v1"
        and LOGIN_URL = "/login?target_path={redirect_url}"
        and redirect_url = "http://127.0.0.1:9006/post_login"
        Returns: "http://localhost:8000/login?target_path=http%3A%2F%2F127.0.0.1%3A9006%2Fpost_login"
    """
    from flow_sdk.client import ApiConfig

    # Create config from environment
    config = ApiConfig.from_env()

    # Get the full login URL template
    login_url_template = config.get_full_login_url()

    # URL encode the redirect URL
    encoded_redirect = quote(redirect_url, safe='')

    # Replace {redirect_url} placeholder with the encoded redirect URL
    login_url = login_url_template.replace("{redirect_url}", encoded_redirect)

    return login_url
