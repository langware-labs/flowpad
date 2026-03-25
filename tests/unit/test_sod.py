"""Unit tests for SOD (Secure Object Database) implementation."""

import json
import os
import tempfile
import pytest
from pathlib import Path

from flow_sdk.config import ServiceConfig, SodProvider
from flow_sdk.sod import SodDriver, FileSodStorage, get_sod_driver
from flow_sdk.sod.sod_provider_base import merge_dicts
from flow_sdk.request_context import RequestInfo
from cryptography.fernet import Fernet


class TestMergeDicts:
    """Test dictionary merging utility."""

    def test_merge_simple_dicts(self):
        """Test merging two simple dictionaries."""
        dest = {"a": 1, "b": 2}
        source = {"c": 3}
        result = merge_dicts(dest, source)
        assert result == {"a": 1, "b": 2, "c": 3}

    def test_merge_overwrites_values(self):
        """Test that source values overwrite destination values."""
        dest = {"a": 1, "b": 2}
        source = {"b": 20, "c": 3}
        result = merge_dicts(dest, source)
        assert result == {"a": 1, "b": 20, "c": 3}

    def test_merge_nested_dicts(self):
        """Test recursive merging of nested dictionaries."""
        dest = {"a": 1, "nested": {"x": 10, "y": 20}}
        source = {"nested": {"y": 200, "z": 300}, "c": 3}
        result = merge_dicts(dest, source)
        assert result == {"a": 1, "nested": {"x": 10, "y": 200, "z": 300}, "c": 3}

    def test_merge_does_not_modify_originals(self):
        """Test that original dictionaries are not modified."""
        dest = {"a": 1}
        source = {"b": 2}
        merge_dicts(dest, source)
        assert dest == {"a": 1}
        assert source == {"b": 2}


class TestSodDriverEncoding:
    """Test SOD payload encoding/decoding."""

    def test_encode_string(self):
        """Test encoding a string value."""
        encoded = SodDriver.encode_sod_payload("secret_value")
        data = json.loads(encoded)
        assert data == {"value": "secret_value"}

    def test_encode_dict(self):
        """Test encoding a dictionary value."""
        payload = {"api_key": "abc123", "token": "xyz789"}
        encoded = SodDriver.encode_sod_payload(payload)
        data = json.loads(encoded)
        assert data == {"value": payload}

    def test_encode_list(self):
        """Test encoding a list value."""
        payload = ["item1", "item2", "item3"]
        encoded = SodDriver.encode_sod_payload(payload)
        data = json.loads(encoded)
        assert data == {"value": payload}

    def test_decode_string(self):
        """Test decoding a string value."""
        encoded = json.dumps({"value": "secret_value"})
        decoded = SodDriver.decode_sod_payload(encoded)
        assert decoded == "secret_value"

    def test_decode_dict(self):
        """Test decoding a dictionary value."""
        payload = {"api_key": "abc123"}
        encoded = json.dumps({"value": payload})
        decoded = SodDriver.decode_sod_payload(encoded)
        assert decoded == payload

    def test_encode_decode_roundtrip(self):
        """Test that encode/decode are inverse operations."""
        original = {"nested": {"key": "value"}, "list": [1, 2, 3]}
        encoded = SodDriver.encode_sod_payload(original)
        decoded = SodDriver.decode_sod_payload(encoded)
        assert decoded == original


class TestFileSodStorage:
    """Test file-based SOD storage implementation."""

    @pytest.fixture
    def temp_dir(self):
        """Create a temporary directory for testing."""
        with tempfile.TemporaryDirectory() as tmpdir:
            yield tmpdir

    @pytest.fixture
    def config(self, temp_dir):
        """Create a test configuration."""
        enc_key = Fernet.generate_key().decode()
        cfg = ServiceConfig(
            development=True,
            sod_provider=SodProvider.DEV_FILE.value,
            sod_file_name=os.path.join(temp_dir, "test_sod.local"),
            sod_enc_key=enc_key,
        )
        return cfg

    @pytest.fixture
    def storage(self, config):
        """Create a FileSodStorage instance."""
        return FileSodStorage(config)

    @pytest.mark.asyncio
    async def test_store_and_load(self, storage):
        """Test storing and loading a secret."""
        await storage.write_sod("test_key", "test_value")
        result = await storage.read_sod("test_key")
        assert result == "test_value"

    @pytest.mark.asyncio
    async def test_store_and_load_dict(self, storage):
        """Test storing and loading a dictionary."""
        data = {"api_key": "abc123", "secret": "xyz789"}
        await storage.write_sod("creds", data)
        result = await storage.read_sod("creds")
        assert result == data

    @pytest.mark.asyncio
    async def test_store_multiple_secrets(self, storage):
        """Test storing multiple secrets."""
        await storage.write_sod("key1", "value1")
        await storage.write_sod("key2", {"nested": "value2"})
        await storage.write_sod("key3", ["a", "b", "c"])

        assert await storage.read_sod("key1") == "value1"
        assert await storage.read_sod("key2") == {"nested": "value2"}
        assert await storage.read_sod("key3") == ["a", "b", "c"]

    @pytest.mark.asyncio
    async def test_load_nonexistent_key(self, storage):
        """Test loading a key that doesn't exist."""
        with pytest.raises(KeyError):
            await storage.read_sod("nonexistent")

    @pytest.mark.asyncio
    async def test_delete_secret(self, storage):
        """Test deleting a secret."""
        await storage.write_sod("to_delete", "value")
        await storage.delete_sod("to_delete")

        with pytest.raises(KeyError):
            await storage.read_sod("to_delete")

    @pytest.mark.asyncio
    async def test_reset(self, storage):
        """Test resetting all secrets."""
        await storage.write_sod("key1", "value1")
        await storage.write_sod("key2", "value2")

        await storage.reset()

        with pytest.raises(KeyError):
            await storage.read_sod("key1")
        with pytest.raises(KeyError):
            await storage.read_sod("key2")

    @pytest.mark.asyncio
    async def test_update_secret(self, storage):
        """Test updating an existing secret."""
        await storage.write_sod("key", "value1")
        assert await storage.read_sod("key") == "value1"

        await storage.write_sod("key", "value2")
        assert await storage.read_sod("key") == "value2"

    @pytest.mark.asyncio
    async def test_encryption_persists(self, storage, config):
        """Test that data is encrypted when saved and decrypted when loaded."""
        await storage.write_sod("secret", "sensitive_data")

        # Create new storage instance to test persistence
        storage2 = FileSodStorage(config)
        result = await storage2.read_sod("secret")
        assert result == "sensitive_data"

    @pytest.mark.asyncio
    async def test_user_sod_with_context(self, storage):
        """Test user-scoped SOD operations (without request context)."""
        # For unit tests, we skip context-based user SOD and use explicit foreign keys
        # In production, this would use the request context
        await storage.write_user_sod("oauth_token", {"access": "token_abc"}, foreign_key="user_123")
        result = await storage.read_user_sod("oauth_token", foreign_key="user_123")
        assert result == {"access": "token_abc"}

    @pytest.mark.asyncio
    async def test_user_sod_formats_key(self, storage):
        """Test that user SOD key is correctly formatted."""
        # Test that | is replaced with _
        await storage.write_user_sod("token", "value", foreign_key="user|123")
        result = await storage.read_sod("token_user_123")
        assert result == "value"

    @pytest.mark.asyncio
    async def test_user_sod_explicit_foreign_key(self, storage):
        """Test user SOD with explicit foreign key (no context needed)."""
        await storage.write_user_sod("token", "value", foreign_key="user_456")
        result = await storage.read_user_sod("token", foreign_key="user_456")
        assert result == "value"


class TestSodDriverFactory:
    """Test SOD driver factory function."""

    def test_get_dev_file_driver(self):
        """Test getting dev_file SOD driver."""
        enc_key = Fernet.generate_key().decode()
        cfg = ServiceConfig(
            sod_provider=SodProvider.DEV_FILE.value,
            sod_file_name="test.sod",
            sod_enc_key=enc_key,
        )
        driver = get_sod_driver(cfg)
        assert isinstance(driver, FileSodStorage)

    def test_get_driver_with_explicit_provider(self):
        """Test getting driver with explicit provider override."""
        enc_key = Fernet.generate_key().decode()
        cfg = ServiceConfig(
            sod_provider=SodProvider.GCP.value,
            sod_enc_key=enc_key,
            google_cloud_project_id="test-project",
        )
        # Request dev_file explicitly
        driver = get_sod_driver(cfg, provider=SodProvider.DEV_FILE.value)
        assert isinstance(driver, FileSodStorage)

    def test_backward_compat_file_alias(self):
        """Test backward compatibility with 'file' alias for 'dev_file'."""
        enc_key = Fernet.generate_key().decode()
        cfg = ServiceConfig(
            sod_provider="file",  # Old name
            sod_file_name="test.sod",
            sod_enc_key=enc_key,
        )
        driver = get_sod_driver(cfg)
        assert isinstance(driver, FileSodStorage)

    def test_invalid_provider_raises_error(self):
        """Test that invalid provider raises ValueError."""
        cfg = ServiceConfig(sod_provider="invalid_provider")
        with pytest.raises(ValueError, match="Invalid sod_provider"):
            get_sod_driver(cfg)



class TestSodTypes:
    """Test SOD payload type handling."""

    @pytest.fixture
    def storage(self):
        """Create a FileSodStorage instance."""
        enc_key = Fernet.generate_key().decode()
        cfg = ServiceConfig(
            development=True,
            sod_provider=SodProvider.DEV_FILE.value,
            sod_file_name=tempfile.mktemp(),
            sod_enc_key=enc_key,
        )
        return FileSodStorage(cfg)

    @pytest.mark.asyncio
    async def test_string_payload(self, storage):
        """Test storing string payloads."""
        await storage.write_sod("str_key", "string_value")
        assert await storage.read_sod("str_key") == "string_value"

    @pytest.mark.asyncio
    async def test_int_payload(self, storage):
        """Test storing integer payloads."""
        await storage.write_sod("int_key", 12345)
        assert await storage.read_sod("int_key") == 12345

    @pytest.mark.asyncio
    async def test_float_payload(self, storage):
        """Test storing float payloads."""
        await storage.write_sod("float_key", 3.14159)
        assert await storage.read_sod("float_key") == 3.14159

    @pytest.mark.asyncio
    async def test_dict_payload(self, storage):
        """Test storing dictionary payloads."""
        data = {"nested": {"deep": {"value": "here"}}}
        await storage.write_sod("dict_key", data)
        assert await storage.read_sod("dict_key") == data

    @pytest.mark.asyncio
    async def test_list_payload(self, storage):
        """Test storing list payloads."""
        data = [1, "two", 3.0, {"four": 4}]
        await storage.write_sod("list_key", data)
        assert await storage.read_sod("list_key") == data


class TestSodRawAPI:
    """Test raw SOD storage API (store_raw_sod / load_raw_sod).

    Migrated from flow-sdk/python/tests/unit/test_sod.py.
    """

    @pytest.fixture
    def storage(self, tmp_path):
        """Create a FileSodStorage instance with fresh temp file."""
        enc_key = Fernet.generate_key().decode()
        cfg = ServiceConfig(
            development=True,
            sod_provider=SodProvider.DEV_FILE.value,
            sod_file_name=os.path.join(str(tmp_path), "test_sod.enc"),
            sod_enc_key=enc_key,
        )
        return FileSodStorage(cfg)

    @pytest.mark.asyncio
    async def test_raw_store_and_load(self, storage):
        """Test raw storage API."""
        await storage.store_raw_sod("test", "123")
        val = await storage.load_raw_sod("test")
        assert val == "123"

    @pytest.mark.asyncio
    async def test_raw_non_exist(self, storage):
        """Test raw load of non-existent key."""
        with pytest.raises(KeyError):
            await storage.load_raw_sod("non_exist")

    @pytest.mark.asyncio
    async def test_sod_race(self, storage):
        """Test sequential write/read operations."""
        for i in range(5):
            await storage.write_sod("test", i)
            val = await storage.read_sod("test")
            assert val == i


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
