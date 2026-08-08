"""Unit tests for storage system and filesystem operations.

Tests VFSPath, storage drivers, FSEntry entities, and API responses.
"""

import asyncio
import os
import tempfile
from io import BytesIO
from pathlib import Path

import pytest

from flow_sdk.api.fs.fs_api import VFSPath, EntityFSReqInfo, parse_custom_uri
from flow_sdk.api.type_id import TypeId
from flow_sdk.models import FSEntry
from flow_sdk.responses import ApiSuccessResponse, ApiFailResponse, ApiResponseStatus
from flow_sdk.storage import LocalStorageDriver


class TestVFSPath:
    """Tests for VFSPath parsing and path manipulation"""

    def test_parse_custom_uri_simple(self):
        """Test parsing simple type-uuid format"""
        parsed = parse_custom_uri("project-@local/path/to/file.txt")
        assert parsed["type"] == "project"
        assert parsed["uuid"] == "@local"
        assert parsed["path"] == "/path/to/file.txt"

    def test_parse_custom_uri_with_protocol(self):
        """Test parsing URI with vfs:// protocol"""
        parsed = parse_custom_uri("vfs://project-@local/path/to/file.txt")
        assert parsed["protocol"] == "vfs"
        assert parsed["type"] == "project"
        assert parsed["uuid"] == "@local"
        assert parsed["path"] == "/path/to/file.txt"

    def test_vfspath_from_entity_path(self):
        """Test creating VFSPath from TypeId and entity path"""
        typeid = TypeId(type="project", id="@local")
        vpath = VFSPath.from_entity_path(typeid, "folder/file.txt")
        assert vpath.type == "project"
        assert vpath.uuid == "@local"
        assert vpath.entity_sub_path == "folder/file.txt"
        assert vpath.is_absolute()

    def test_vfspath_filename(self):
        """Test extracting filename from VFSPath"""
        vpath = VFSPath("project-@local/path/to/file.txt")
        assert vpath.filename == "file.txt"

    def test_vfspath_typeid_property(self):
        """Test TypeId property on VFSPath"""
        vpath = VFSPath("project-@local/path/to/file")
        assert vpath.typeid is not None
        assert vpath.typeid.type == "project"
        assert vpath.typeid.id == "@local"


class TestFSEntry:
    """Tests for FSEntry Pydantic model"""

    def test_fsitem_creation(self):
        """Test creating FSEntry instance"""
        item = FSEntry(
            vfs_abs_path="project-@local/file.txt",
            is_dir=False,
            size=1024,
            display_name="file.txt",
        )
        assert item.type == "fs_entry"
        assert item.vfs_abs_path == "project-@local/file.txt"
        assert item.is_dir == False
        assert item.size == 1024

    def test_fsitem_directory(self):
        """Test FSEntry for directory"""
        item = FSEntry(
            vfs_abs_path="project-@local/folder",
            is_dir=True,
            display_name="folder",
        )
        assert item.is_dir == True
        assert item.size is None  # Directories don't have size

    def test_fsitem_with_symlink(self):
        """Test FSEntry with symlink target"""
        item = FSEntry(
            vfs_abs_path="project-@local/link",
            is_dir=False,
            symlink_target="/path/to/target",
        )
        assert item.symlink_target == "/path/to/target"


class TestApiResponses:
    """Tests for API response classes"""

    def test_success_response(self):
        """Test creating success response"""
        resp = ApiSuccessResponse(data={"status": "ok"})
        assert resp.status == "SUCCESS"
        assert resp.message == "success"
        assert resp.data == {"status": "ok"}

    def test_fail_response(self):
        """Test creating fail response"""
        resp = ApiFailResponse(message="Error occurred", data=None)
        assert resp.status == "FAIL"
        assert resp.message == "Error occurred"

    def test_response_model_dump(self):
        """Test response serialization"""
        resp = ApiSuccessResponse(data={"key": "value"})
        dumped = resp.model_dump()
        assert dumped["status"] == "SUCCESS"
        assert dumped["message"] == "success"
        assert dumped["data"] == {"key": "value"}


@pytest.mark.asyncio
class TestLocalStorageDriver:
    """Tests for LocalStorageDriver"""

    @pytest.fixture
    async def storage(self):
        """Create temporary storage for testing"""
        with tempfile.TemporaryDirectory() as tmpdir:
            driver = LocalStorageDriver(mount_path=tmpdir)
            yield driver, tmpdir

    async def test_create_folder(self, storage):
        """Test creating a folder"""
        driver, tmpdir = storage
        await driver.create_folder("test_folder")
        assert os.path.isdir(os.path.join(tmpdir, "test_folder"))

    async def test_upload_file(self, storage):
        """Test uploading a file"""
        driver, tmpdir = storage
        content = b"Hello, World!"
        await driver.upload(BytesIO(content), "test_file.txt")
        file_path = os.path.join(tmpdir, "test_file.txt")
        assert os.path.isfile(file_path)
        with open(file_path, "rb") as f:
            assert f.read() == content

    async def test_download_file(self, storage):
        """Test downloading a file"""
        driver, tmpdir = storage
        # Create a file
        file_path = os.path.join(tmpdir, "test_file.txt")
        test_content = b"Test content"
        with open(file_path, "wb") as f:
            f.write(test_content)

        # Download it
        output = BytesIO()
        await driver.download("test_file.txt", output)
        assert output.getvalue() == test_content

    async def test_exists(self, storage):
        """Test checking file existence"""
        driver, tmpdir = storage
        # File doesn't exist
        assert not await driver.exists("nonexistent.txt")

        # Create file
        file_path = os.path.join(tmpdir, "exists_test.txt")
        Path(file_path).touch()

        # File exists
        assert await driver.exists("exists_test.txt")

    async def test_delete_file(self, storage):
        """Test deleting a file"""
        driver, tmpdir = storage
        # Create file
        file_path = os.path.join(tmpdir, "delete_test.txt")
        Path(file_path).touch()
        assert os.path.isfile(file_path)

        # Delete it
        await driver.delete("delete_test.txt")
        assert not os.path.isfile(file_path)

    async def test_list_dir(self, storage):
        """Test listing directory contents"""
        driver, tmpdir = storage
        # Create some files
        Path(os.path.join(tmpdir, "file1.txt")).touch()
        Path(os.path.join(tmpdir, "file2.txt")).touch()
        os.makedirs(os.path.join(tmpdir, "subfolder"))

        # List directory
        items = await driver.list_dir("/")
        names = {item.display_name for item in items}
        assert "file1.txt" in names
        assert "file2.txt" in names
        assert "subfolder" in names

    async def test_move_file(self, storage):
        """Test moving a file"""
        driver, tmpdir = storage
        # Create file
        src_path = os.path.join(tmpdir, "source.txt")
        Path(src_path).touch()

        # Move it
        await driver.move("source.txt", "destination.txt")
        dst_path = os.path.join(tmpdir, "destination.txt")
        assert not os.path.exists(src_path)
        assert os.path.isfile(dst_path)

    async def test_copy_file(self, storage):
        """Test copying a file"""
        driver, tmpdir = storage
        # Create file
        src_path = os.path.join(tmpdir, "original.txt")
        Path(src_path).write_text("content")

        # Copy it
        await driver.copy("original.txt", "copy.txt")
        dst_path = os.path.join(tmpdir, "copy.txt")
        assert os.path.isfile(src_path)
        assert os.path.isfile(dst_path)
        assert Path(dst_path).read_text() == "content"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
