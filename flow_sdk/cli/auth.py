#!/usr/bin/env python3
"""
Authentication module for flow CLI.
Manages API keys using system keyring.
"""

import keyring
from enum import Enum


class AuthConstants(Enum):
    """Authentication-related constants."""
    SERVICE_NAME = "Flowpad.ai"
    API_KEY_NAME = "flowpad_api_key"


def set_api_key(api_key: str) -> None:
    """
    Store the API key in the system keyring.

    Args:
        api_key: The API key to store
    """
    keyring.set_password(
        AuthConstants.SERVICE_NAME.value,
        AuthConstants.API_KEY_NAME.value,
        api_key
    )


def get_api_key() -> str | None:
    """
    Retrieve the API key from the system keyring.

    Returns:
        str | None: The stored API key, or None if not found
    """
    return keyring.get_password(
        AuthConstants.SERVICE_NAME.value,
        AuthConstants.API_KEY_NAME.value
    )


def delete_api_key() -> None:
    """
    Delete the API key from the system keyring.
    """
    try:
        keyring.delete_password(
            AuthConstants.SERVICE_NAME.value,
            AuthConstants.API_KEY_NAME.value
        )
    except keyring.errors.PasswordDeleteError:
        # Key doesn't exist, that's fine
        pass


def is_logged_in() -> bool:
    """
    Check if the user is logged in (has an API key stored).

    Returns:
        bool: True if API key is stored, False otherwise
    """
    return get_api_key() is not None


async def _validate_api_key_async(api_key: str) -> dict:
    """
    Async implementation of API key validation.

    Args:
        api_key: The API key to validate

    Returns:
        dict: User information if valid (must contain "id" field)

    Raises:
        Exception: If API key is invalid or validation fails
    """
    from flow_sdk.client import FlowpadClient, ApiConfig

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
            user_data = asyncio.run(_validate_api_key_async(api_key))
        else:
            # We're in an async context, can't use asyncio.run() or run_until_complete()
            # Create a new thread to run the async code
            import concurrent.futures
            with concurrent.futures.ThreadPoolExecutor() as executor:
                future = executor.submit(asyncio.run, _validate_api_key_async(api_key))
                user_data = future.result()

        return user_data
    except Exception as e:
        raise Exception(f"API key validation failed: {str(e)}")
