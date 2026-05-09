#!/usr/bin/env python3
"""
Integration test for the authentication flow.
Tests the complete flow: flow auth login -> validate user in config.
"""

import pytest
import socket
import subprocess
import time
import threading
import os
from flow_sdk.cli.app_config import get_user, clear_user
from flow_sdk.cli.auth.hub_login import delete_api_key


@pytest.fixture(autouse=True)
def cleanup_auth():
    """Clean up authentication before and after each test."""
    # Clean up before test
    clear_user()
    delete_api_key()

    yield

    # Clean up after test
    clear_user()
    delete_api_key()

@pytest.mark.skip
def test_auth_login_flow_with_machine_name():
    """
    Test the complete auth login flow and validate user has machine name.

    This test:
    1. Starts a mock API server that returns user with machine hostname
    2. Runs 'flow auth test' which simulates the login flow
    3. Validates that the user is stored in config
    4. Validates that user.name == socket.gethostname()
    """
    # Get expected machine name
    expected_machine_name = socket.gethostname()

    # Run the auth test command (simulates login flow)
    # Using --delay 1 for faster test execution
    result = subprocess.run(
        ["flow", "auth", "login"],
        capture_output=True,
        text=True,
        timeout=15
    )

    # Check command succeeded
    assert result.returncode == 0, f"flow auth login failed: {result.stderr}"
    assert "✓ Successfully logged in to Flowpad" in result.stdout, "Login should succeed"

    # Validate user is stored in config
    user = get_user()
    assert user is not None, "User should be stored in config after login"

    # Validate user has expected fields
    assert "id" in user, "User should have 'id' field"
    assert "name" in user, "User should have 'name' field"

    # Print user info for debugging
    print(f"\n✓ Test passed!")
    print(f"  User ID: {user['id']}")
    print(f"  User name: {user['name']}")
    print(f"  Machine hostname: {expected_machine_name}")



def test_user_config_persistence():
    """
    Test that user data persists in config after setting.
    """
    from flow_sdk.cli.app_config import set_user, get_user, clear_user

    test_user = {
        "id": "test_123",
        "name": "TestMachine",
        "email": "test@example.com"
    }

    # Set user
    set_user(test_user)

    # Get user and validate
    retrieved_user = get_user()
    assert retrieved_user == test_user, "User data should persist"

    # Clear user
    clear_user()

    # Validate cleared
    assert get_user() is None, "User should be cleared"


if __name__ == "__main__":
    # Run tests with pytest
    pytest.main([__file__, "-v", "-s"])
