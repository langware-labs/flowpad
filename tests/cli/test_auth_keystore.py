#!/usr/bin/env python3
"""
Tests for authentication and keystore functionality.
"""

import pytest
from flow_sdk.cli.auth import (
    set_api_key,
    get_api_key,
    delete_api_key,
    is_logged_in,
    AuthConstants
)


def test_auth_keystore():
    """
    Test basic keystore operations: set, get, delete API key.
    """
    test_api_key = "test-api-key-12345"

    # Clean up any existing key first
    delete_api_key()

    # Step 1: Verify not logged in initially
    assert not is_logged_in(), "Should not be logged in initially"
    assert get_api_key() is None, "API key should be None initially"
    print("✓ Step 1: Initial state verified - not logged in")

    # Step 2: Set API key
    set_api_key(test_api_key)
    print(f"✓ Step 2: API key set")

    # Step 3: Verify logged in and key is stored
    assert is_logged_in(), "Should be logged in after setting key"
    stored_key = get_api_key()
    assert stored_key == test_api_key, f"Expected key '{test_api_key}', got '{stored_key}'"
    print(f"✓ Step 3: API key retrieved successfully")

    # Step 4: Delete API key
    delete_api_key()
    print(f"✓ Step 4: API key deleted")

    # Step 5: Verify logged out
    assert not is_logged_in(), "Should not be logged in after deleting key"
    assert get_api_key() is None, "API key should be None after deletion"
    print("✓ Step 5: Verified logged out - API key deleted")

    print("\n✅ All keystore operations work correctly")


def test_auth_constants():
    """
    Test that auth constants are properly defined.
    """
    assert AuthConstants.SERVICE_NAME.value == "Flowpad.ai", \
        f"Expected SERVICE_NAME='Flowpad.ai', got '{AuthConstants.SERVICE_NAME.value}'"

    assert AuthConstants.API_KEY_NAME.value == "flowpad_api_key", \
        f"Expected API_KEY_NAME='flowpad_api_key', got '{AuthConstants.API_KEY_NAME.value}'"

    print("✓ Auth constants verified:")
    print(f"  - SERVICE_NAME: {AuthConstants.SERVICE_NAME.value}")
    print(f"  - API_KEY_NAME: {AuthConstants.API_KEY_NAME.value}")

    print("\n✅ Auth constants are correct")


def test_delete_nonexistent_key():
    """
    Test that deleting a non-existent key doesn't raise an error.
    """
    # Ensure key doesn't exist
    delete_api_key()

    # Try to delete again - should not raise error
    delete_api_key()

    assert not is_logged_in(), "Should not be logged in"
    print("✓ Deleting non-existent key handled gracefully")

    print("\n✅ Non-existent key deletion works correctly")
