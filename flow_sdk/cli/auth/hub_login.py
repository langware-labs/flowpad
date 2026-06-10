#!/usr/bin/env python3
"""Authentication helpers for the flow CLI.

Credentials are stored per-instance in the encrypted sodot file. See
``flow_sdk/cli/auth/credentials.py`` for the storage layer. Per-instance
partitioning is automatic (each instance has its own sodot + Fernet key)
— two local instances logged in as different cloud users never overwrite
each other's token.
"""

from flow_sdk.cli.auth.credentials import (
    UserHubCredentials,
    clear_credentials,
    load_credentials,
    save_credentials,
)


def set_api_key(api_key: str) -> None:
    """Store the API key in the system keyring."""
    save_credentials(UserHubCredentials(api_key=api_key))


def get_api_key() -> str | None:
    """Retrieve the API key from the system keyring."""
    creds = load_credentials()
    return creds.api_key if creds else None


def delete_api_key() -> None:
    """Delete the API key from the system keyring (idempotent)."""
    clear_credentials()


def is_logged_in() -> bool:
    """
    Check if the user is logged in.

    Uses the file-based user record rather than reading the OS keyring, so this
    is safe to call at startup without triggering a keychain access prompt for
    the hub API key. The keyring is only consulted when the API key value is
    actually needed (``get_api_key``).

    Returns:
        bool: True if a non-empty user record exists, False otherwise
    """
    from flow_sdk.cli.app_config import get_user
    return bool(get_user())


def hub_auth_available() -> bool:
    """True when a hub request would carry credentials — via the cloud_api_key
    instance setting (CI/headless) OR a file-based login.

    Mirrors the auth decision in ``cloud_client.client_hooks._on_request`` so
    callers can skip hub calls that would otherwise 401 while logged out. Both
    checks are cheap and keychain-safe (the api_key is a plain setting read and
    ``is_logged_in`` reads the file-based user record), so this is safe to call
    per request.
    """
    from flow_sdk.instance_settings import get_instance_settings
    if get_instance_settings().cloud_api_key:
        return True
    return is_logged_in()


async def validate_api_key_async(api_key: str) -> dict:
    """
    Async implementation of API key validation.

    Args:
        api_key: The API key to validate

    Returns:
        dict: User information if valid (must contain "id" field)

    Raises:
        Exception: If API key is invalid or validation fails
    """
    from flow_sdk.cloud_client import FlowpadClient, ApiConfig

    config = ApiConfig.from_env()
    async with FlowpadClient(config, api_key=api_key) as client:
        # get_user() raises on non-200 or if the body is missing 'id'.
        return await client.get_user()


def validate_api_key(api_key: str) -> dict:
    """
    Validate an API key with the Flowpad backend.

    Args:
        api_key: The API key to validate

    Returns:
        dict: User information if valid (must contain "id" field)

    Raises:
        Exception: If API key is invalid or validation fails
    """
    import asyncio

    # Run the async validation
    try:
        # Check if there's already a running event loop
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            # No running loop, safe to use asyncio.run()
            user_data = asyncio.run(validate_api_key_async(api_key))
        else:
            # We're in an async context, can't use asyncio.run() or run_until_complete()
            # Create a new thread to run the async code
            import concurrent.futures
            with concurrent.futures.ThreadPoolExecutor() as executor:
                future = executor.submit(asyncio.run, validate_api_key_async(api_key))
                user_data = future.result()

        return user_data
    except Exception as e:
        raise Exception(f"API key validation failed: {str(e)}")
