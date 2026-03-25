#!/usr/bin/env python3
"""
Tests for app_config module.
"""

import pytest
from pathlib import Path
import json
from flow_sdk.cli.app_config import (
    set_config,
    get_config,
    config_file_path,
    get_user,
    set_user,
    clear_user
)


def test_app_config_basic():
    """Test basic set/get operations with native types."""
    # Test string
    set_config('test_string', 'hello world')
    assert get_config('test_string') == 'hello world'

    # Test int
    set_config('test_int', 42)
    assert get_config('test_int') == 42

    # Test float
    set_config('test_float', 3.14)
    assert get_config('test_float') == 3.14

    # Test bool
    set_config('test_bool', True)
    assert get_config('test_bool') is True

    # Test default value
    assert get_config('nonexistent_key', 'default') == 'default'

    print("✓ Basic config operations work correctly")
    print("\n✅ Basic app_config test PASSED")


def test_app_config_json():
    """Test complex types (dict, list) stored as JSON."""
    # Test dict
    test_dict = {'name': 'John', 'age': 30, 'active': True}
    set_config('test_dict', test_dict)
    retrieved_dict = get_config('test_dict')
    assert retrieved_dict == test_dict
    assert isinstance(retrieved_dict, dict)

    # Test list
    test_list = [1, 2, 3, 'four', 5.0]
    set_config('test_list', test_list)
    retrieved_list = get_config('test_list')
    assert retrieved_list == test_list
    assert isinstance(retrieved_list, list)

    # Test nested structure
    nested = {
        'user': {'id': 123, 'name': 'Alice'},
        'settings': {'theme': 'dark', 'notifications': True}
    }
    set_config('test_nested', nested)
    retrieved_nested = get_config('test_nested')
    assert retrieved_nested == nested

    print("✓ JSON config operations work correctly")
    print("\n✅ JSON app_config test PASSED")


def test_app_config_file_path():
    """Test that config_file_path is exposed and valid."""
    assert config_file_path is not None
    assert isinstance(config_file_path, Path)
    assert config_file_path.name == 'config.json'
    assert 'flow-cli' in str(config_file_path)

    print(f"✓ Config file path: {config_file_path}")
    print("\n✅ Config file path test PASSED")


def test_user_operations():
    """Test user-specific operations."""
    # Clear any existing user
    clear_user()

    # Verify no user initially
    assert get_user() is None

    # Set user info
    user_info = {'id': 'test_user_123', 'name': 'Test User', 'email': 'test@example.com'}
    set_user(user_info)

    # Get user info
    retrieved_user = get_user()
    assert retrieved_user is not None
    assert retrieved_user == user_info
    assert retrieved_user['id'] == 'test_user_123'

    print(f"✓ User stored: {retrieved_user}")

    # Clear user
    clear_user()
    assert get_user() is None

    print("✓ User operations work correctly")
    print("\n✅ User operations test PASSED")
