"""Integration tests for filesystem operations.

Tests complete workflows: browse → upload → download → delete
"""

import tempfile
from io import BytesIO

import pytest

from flow_sdk.api.type_id import TypeId
from flow_sdk.storage import LocalStorageDriver


@pytest.mark.asyncio
class TestFilesystemWorkflow:
    """Test complete filesystem workflows"""

    @pytest.fixture
    async def project_storage(self):
        """Create storage for a project entity"""
        with tempfile.TemporaryDirectory() as tmpdir:
            driver = LocalStorageDriver(tmpdir)
            driver.root_entity_typeid = TypeId(type="project", id="@local")
            yield driver, tmpdir

    async def test_workflow_browse_upload_download_delete(self, project_storage):
        """Test complete workflow: browse → upload → download → delete"""
        driver, tmpdir = project_storage

        # Step 1: Initial browse (empty)
        items = await driver.list_dir("/")
        assert len(items) == 0, "Storage should start empty"

        # Step 2: Create a folder
        await driver.create_folder("documents")
        items = await driver.list_dir("/")
        assert len(items) == 1
        assert items[0].display_name == "documents"
        assert items[0].is_dir == True

        # Step 3: Upload a file to the folder
        file_content = b"This is a test document content"
        await driver.upload(BytesIO(file_content), "documents/test.txt")

        # Browse folder
        items = await driver.list_dir("documents")
        assert len(items) == 1
        assert items[0].display_name == "test.txt"
        assert items[0].size == len(file_content)

        # Step 4: Upload multiple files
        file2_content = b"Another test file"
        await driver.upload(BytesIO(file2_content), "documents/another.txt")

        items = await driver.list_dir("documents")
        assert len(items) == 2
        names = {item.display_name for item in items}
        assert "test.txt" in names
        assert "another.txt" in names

        # Step 5: Download a file
        downloaded = BytesIO()
        await driver.download("documents/test.txt", downloaded)
        assert downloaded.getvalue() == file_content

        # Step 6: Delete a file
        await driver.delete("documents/test.txt")
        items = await driver.list_dir("documents")
        assert len(items) == 1
        assert items[0].display_name == "another.txt"

        # Step 7: Delete the folder
        await driver.delete("documents")
        items = await driver.list_dir("/")
        assert len(items) == 0

    async def test_workflow_nested_structure(self, project_storage):
        """Test creating and navigating nested directory structure"""
        driver, tmpdir = project_storage

        # Create nested structure
        await driver.create_folder("src")
        await driver.create_folder("src/components")
        await driver.create_folder("src/utils")

        # Upload files to different levels
        await driver.upload(BytesIO(b"import React"), "src/index.js")
        await driver.upload(BytesIO(b"export function Button()"), "src/components/Button.tsx")
        await driver.upload(BytesIO(b"export function helper()"), "src/utils/helper.ts")

        # Browse root
        items = await driver.list_dir("/")
        assert len(items) == 1
        assert items[0].display_name == "src"

        # Browse src
        items = await driver.list_dir("src")
        names = {item.display_name for item in items}
        assert "index.js" in names
        assert "components" in names
        assert "utils" in names

        # Browse src/components
        items = await driver.list_dir("src/components")
        assert len(items) == 1
        assert items[0].display_name == "Button.tsx"

    async def test_workflow_copy_and_rename(self, project_storage):
        """Test copy and rename operations"""
        driver, tmpdir = project_storage

        # Create and upload original file
        original_content = b"Original file content"
        await driver.upload(BytesIO(original_content), "original.txt")

        # Copy file
        await driver.copy("original.txt", "copy.txt")
        items = await driver.list_dir("/")
        assert len(items) == 2

        # Verify copy content matches original
        copied_content = BytesIO()
        await driver.download("copy.txt", copied_content)
        assert copied_content.getvalue() == original_content

        # Rename copy
        await driver.move("copy.txt", "renamed.txt")
        items = await driver.list_dir("/")
        names = {item.display_name for item in items}
        assert "original.txt" in names
        assert "renamed.txt" in names
        assert "copy.txt" not in names

    async def test_workflow_vfs_path_handling(self, project_storage):
        """Test VFSPath handling with TypeId prefix"""
        driver, tmpdir = project_storage
        typeid = TypeId(type="project", id="@local")

        # Create files and verify vfs_abs_path
        await driver.create_folder("data")
        items = await driver.list_dir("/")

        folder_item = items[0]
        assert folder_item.vfs_abs_path.startswith("project-@local")
        assert "data" in folder_item.vfs_abs_path

    async def test_workflow_large_file(self, project_storage):
        """Test uploading and downloading a larger file"""
        driver, tmpdir = project_storage

        # Create 1MB file
        large_content = b"X" * (1024 * 1024)
        await driver.upload(BytesIO(large_content), "largefile.bin")

        # Verify upload
        items = await driver.list_dir("/")
        assert items[0].size == len(large_content)

        # Download and verify
        downloaded = BytesIO()
        await driver.download("largefile.bin", downloaded)
        assert len(downloaded.getvalue()) == len(large_content)
        assert downloaded.getvalue() == large_content

    async def test_workflow_special_characters(self, project_storage):
        """Test handling files with special characters"""
        driver, tmpdir = project_storage

        # Upload files with special names
        special_names = [
            "file with spaces.txt",
            "file-with-dashes.txt",
            "file_with_underscores.txt",
        ]

        for name in special_names:
            await driver.upload(BytesIO(b"content"), name)

        # List and verify
        items = await driver.list_dir("/")
        found_names = {item.display_name for item in items}
        for name in special_names:
            assert name in found_names, f"File '{name}' not found in listing"


@pytest.mark.asyncio
async def test_storage_isolation():
    """Test that different storage instances are properly isolated"""
    with tempfile.TemporaryDirectory() as tmpdir1:
        with tempfile.TemporaryDirectory() as tmpdir2:
            # Create two separate storage drivers
            driver1 = LocalStorageDriver(tmpdir1)
            driver2 = LocalStorageDriver(tmpdir2)

            # Upload to first storage
            await driver1.upload(BytesIO(b"Project 1 file"), "file1.txt")

            # Upload to second storage
            await driver2.upload(BytesIO(b"Project 2 file"), "file2.txt")

            # Verify isolation
            items1 = await driver1.list_dir("/")
            items2 = await driver2.list_dir("/")

            assert len(items1) == 1
            assert items1[0].display_name == "file1.txt"

            assert len(items2) == 1
            assert items2[0].display_name == "file2.txt"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
