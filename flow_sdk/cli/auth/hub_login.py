#!/usr/bin/env python3
"""
Authentication module for flow CLI.
Manages API keys using system keyring.

The keyring slot is per-instance: ``prod`` keeps the legacy
``flowpad_api_key`` username (zero migration for installed users); ``dev``
and ``test`` use ``flowpad_api_key:<instance_name>`` so two local
instances logged in as different cloud users don't overwrite each other's
token.
"""

import keyring


SERVICE_NAME = "Flowpad.ai.app_secrets"


def _api_key_name() -> str:
    """Per-instance keyring username — see module docstring."""
    from flow_sdk.instance_settings import get_instance_settings
    name = get_instance_settings().instance_name
    return "flowpad_api_key" if name == "prod" else f"flowpad_api_key:{name}"


def set_api_key(api_key: str) -> None:
    """Store the API key in the system keyring."""
    keyring.set_password(SERVICE_NAME, _api_key_name(), api_key)


def get_api_key() -> str | None:
    """Retrieve the API key from the system keyring."""
    return keyring.get_password(SERVICE_NAME, _api_key_name())


def delete_api_key() -> None:
    """Delete the API key from the system keyring (idempotent)."""
    try:
        keyring.delete_password(SERVICE_NAME, _api_key_name())
    except keyring.errors.PasswordDeleteError:
        pass


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

    # Create API config from environment
    config = ApiConfig.from_env()

    # Create client
    async with FlowpadClient(config) as client:
        # Set the API key
        client.set_api_key(api_key)

        # Call get_user() which validates the key
        # This will raise an exception if the request fails (non-200)
        # or if the response doesn't have an 'id' field
        user_data = await client.get_user()

        return user_data


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
