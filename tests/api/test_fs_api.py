"""API tests for filesystem operations.

Tests fs/browse endpoint with real files from the machine.
"""

import os
import tempfile

import pytest

from flow_sdk.api.type_id import TypeId
from flow_sdk.config import StorageProvider
from flow_sdk.storage import LocalStorageDriver


@pytest.mark.asyncio
class TestFsApiBrowse:
    """Test fs/browse API operations"""

    @pytest.fixture
    def machine_root_storage(self):
        """Create storage driver pointing to machine root"""
        driver = LocalStorageDriver("/")
        driver.root_entity_typeid = TypeId(type="compute_node", id="local")
        return driver

    @pytest.fixture
    def temp_storage(self):
        """Create storage with temp directory containing test files"""
        with tempfile.TemporaryDirectory() as tmpdir:
            # Create test structure
            os.makedirs(os.path.join(tmpdir, "test_folder"))
            with open(os.path.join(tmpdir, "test_file.txt"), "w") as f:
                f.write("test content")
            with open(os.path.join(tmpdir, "test_folder", "nested.txt"), "w") as f:
                f.write("nested content")

            driver = LocalStorageDriver(tmpdir)
            driver.root_entity_typeid = TypeId(type="project", id="@local")
            yield driver, tmpdir

    async def test_browse_folder_returns_contents(self, temp_storage):
        """Test that browsing a folder returns its contents"""
        driver, tmpdir = temp_storage

        # Browse root
        items = await driver.list_dir("/")

        assert len(items) == 2
        names = {item.display_name for item in items}
        assert "test_file.txt" in names
        assert "test_folder" in names

        # Verify file vs folder
        file_item = next(i for i in items if i.display_name == "test_file.txt")
        folder_item = next(i for i in items if i.display_name == "test_folder")

        assert file_item.is_dir == False
        assert folder_item.is_dir == True

    async def test_browse_nested_folder(self, temp_storage):
        """Test browsing a nested folder"""
        driver, tmpdir = temp_storage

        items = await driver.list_dir("test_folder")

        assert len(items) == 1
        assert items[0].display_name == "nested.txt"
        assert items[0].is_dir == False

    async def test_browse_nonexistent_folder(self, temp_storage):
        """Test browsing a non-existent folder returns empty list"""
        driver, tmpdir = temp_storage

        # Non-existent folders return empty list (storage creates path if needed)
        items = await driver.list_dir("nonexistent_folder")
        assert items == []

    async def test_read_file_exists(self, temp_storage):
        """Test checking if a file exists"""
        driver, tmpdir = temp_storage

        exists = await driver.exists("test_file.txt")
        assert exists == True

    async def test_read_folder_exists(self, temp_storage):
        """Test checking if a folder exists"""
        driver, tmpdir = temp_storage

        exists = await driver.exists("test_folder")
        assert exists == True

    async def test_read_nonexistent_path(self, temp_storage):
        """Test checking non-existent path returns False"""
        driver, tmpdir = temp_storage

        exists = await driver.exists("nonexistent_file.txt")
        assert exists == False

    async def test_download_file_content(self, temp_storage):
        """Test downloading file returns correct content"""
        driver, tmpdir = temp_storage
        from io import BytesIO

        buffer = BytesIO()
        await driver.download("test_file.txt", buffer)

        assert buffer.getvalue() == b"test content"

    async def test_download_nonexistent_file(self, temp_storage):
        """Test downloading non-existent file raises error"""
        driver, tmpdir = temp_storage
        from io import BytesIO

        buffer = BytesIO()
        with pytest.raises(FileNotFoundError):
            await driver.download("nonexistent.txt", buffer)

    async def test_sandbox_storage_provider_uses_mount_path(self):
        """SANDBOX provider should resolve to configured mount path (not embedded fallback)."""
        from flow_sdk.storage import get_entity_storage

        with tempfile.TemporaryDirectory() as tmpdir:
            marker_name = "sandbox-visible.txt"
            marker_path = os.path.join(tmpdir, marker_name)
            with open(marker_path, "w") as f:
                f.write("ok")

            class DummyEntity:
                fs_storage_provider = StorageProvider.SANDBOX
                fs_storage_mount_path = tmpdir

            driver = get_entity_storage(TypeId(type="compute_node", id="@local"), entity=DummyEntity())
            items = await driver.list_dir("/")
            names = {item.display_name for item in items}
            assert marker_name in names


@pytest.mark.asyncio
class TestMachineRootBrowse:
    """Test browsing machine root filesystem via local compute_node"""

    @pytest.fixture
    def local_compute_node(self):
        """Create a local compute_node that mounts machine root"""
        from flow_sdk.builtin.compute_node import ComputeNode
        from flow_sdk.config import ComputeProviderType

        node = ComputeNode(node_provider_type=ComputeProviderType.LOCAL_MACHINE)
        return node

    async def test_local_compute_node_has_root_mount(self, local_compute_node):
        """Test that local compute_node auto-sets fs_storage_mount_path to root"""
        assert local_compute_node.fs_storage_mount_path == "/"
        assert local_compute_node.fs_storage_provider == "local"

    async def test_browse_machine_root(self, local_compute_node):
        """Test browsing the machine root returns system directories"""
        from flow_sdk.storage import get_entity_storage

        driver = get_entity_storage(local_compute_node.typeid, entity=local_compute_node)

        items = await driver.list_dir("/")
        names = {item.display_name for item in items}

        # Machine root should contain common system directories
        # At least some of these should exist on any Unix system
        expected_dirs = {"usr", "bin", "etc", "var", "tmp"}
        found = names & expected_dirs

        assert len(found) >= 2, f"Expected system directories, found: {names}"

    async def test_browse_machine_tmp(self, local_compute_node):
        """Test browsing /tmp directory"""
        from flow_sdk.storage import get_entity_storage

        driver = get_entity_storage(local_compute_node.typeid, entity=local_compute_node)

        # /tmp should exist and be browsable
        items = await driver.list_dir("tmp")

        # Should return a list (may be empty or have items)
        assert isinstance(items, list)

    async def test_read_known_file(self, local_compute_node):
        """Test reading a known system file"""
        from flow_sdk.storage import get_entity_storage

        driver = get_entity_storage(local_compute_node.typeid, entity=local_compute_node)

        # /etc/hosts should exist on any Unix system
        exists = await driver.exists("etc/hosts")
        assert exists == True

    async def test_read_nonexistent_system_path(self, local_compute_node):
        """Test reading non-existent system path"""
        from flow_sdk.storage import get_entity_storage

        driver = get_entity_storage(local_compute_node.typeid, entity=local_compute_node)

        exists = await driver.exists("definitely/not/a/real/path/xyz123")
        assert exists == False


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
