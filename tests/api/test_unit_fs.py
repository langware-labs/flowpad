"""Unit tests for filesystem storage operations (adapted from FlowPad).

Tests VFSPath, storage drivers, and filesystem operations.
"""

import asyncio
import os
import tempfile
import uuid
from io import BytesIO

import pytest

from flow_sdk.api.fs.fs_api import VFSPath
from flow_sdk.api.type_id import TypeId
from flow_sdk.storage import LocalStorageDriver, StoragePermissionError

vpath_file_name = "/uploaded_file.txt"


@pytest.fixture(scope="function")
def storage(tmp_path):
    """Create a LocalStorageDriver backed by a temp directory."""
    driver = LocalStorageDriver(mount_path=str(tmp_path))
    yield driver, str(tmp_path)


@pytest.fixture(scope="function")
def local_file():
    """Create a temporary file with test content."""
    _local_file = tempfile.NamedTemporaryFile(delete=False)
    _local_file.write(b"Test content")
    _local_file.seek(0)
    yield _local_file
    _local_file.close()
    os.unlink(_local_file.name)


# Tests that don't need async context (no request context)
class TestVFSPathBasic:
    """Tests for VFSPath parsing that don't need request context."""

    def test_vfs_path_file_names(self):
        """Test VFSPath with relative file names."""
        path = VFSPath("some.file.txt")
        assert path._raw_path == "some.file.txt"
        assert path.is_absolute() is False
        assert path.entity_sub_path == "some.file.txt"
        assert path.typeid is None

    def test_explicit_typeid_vfs_path(self):
        """Test creating VFSPath with explicit TypeId."""
        some_uuid = str(uuid.uuid4())
        tid = TypeId(type="my_type", id=some_uuid)
        path = VFSPath(f"{tid}/test")
        assert path._raw_path == f"{tid}/test"
        assert path.is_absolute() is True
        assert path.entity_sub_path == "test"
        assert path.typeid == tid

    def test_vfs_protocol_path(self):
        """Test VFSPath with vfs:// protocol."""
        some_uuid = str(uuid.uuid4())
        tid = TypeId(type="my_type", id=some_uuid)
        path = VFSPath(f"{VFSPath.VFS_PATH_PROTOCOL}://{tid}/test")
        assert path.protocol == VFSPath.VFS_PATH_PROTOCOL
        assert path.is_absolute() is True
        assert path.entity_sub_path == "test"
        assert path.typeid == tid

    def test_named_typeid_vfs_path(self):
        """Test VFSPath with named identifier."""
        tid = TypeId(type="project", id="@local")
        path = VFSPath(f"{tid}/test")
        assert path.is_absolute() is True
        assert path.entity_sub_path == "test"
        assert path.typeid == tid


class TestLocalStorageDriver:
    """Tests for LocalStorageDriver basic operations."""

    @pytest.mark.asyncio
    async def test_authenticate(self, storage):
        """Test storage authentication (local storage needs no auth)."""
        driver, tmpdir = storage
        try:
            await driver.setup_storage()
        except Exception as e:
            pytest.fail(f"setup_storage() raised an exception: {e}")

    @pytest.mark.asyncio
    async def test_upload(self, storage, local_file):
        """Test uploading a file to storage."""
        driver, tmpdir = storage
        vfs_path = vpath_file_name
        await driver.upload(local_file.name, vfs_path)
        exists = await driver.exists(vfs_path, 5)
        assert exists

    @pytest.mark.asyncio
    async def test_download(self, storage, local_file):
        """Test downloading a file from storage."""
        driver, tmpdir = storage
        vfs_path = vpath_file_name
        await driver.upload(local_file.name, vfs_path)
        download_path = local_file.name + "_downloaded"
        await driver.download(vfs_path, download_path)
        assert os.path.exists(download_path)
        with open(download_path, "rb") as f:
            content = f.read()
        assert content == b"Test content"
        os.unlink(download_path)

    @pytest.mark.asyncio
    async def test_stream(self, storage, local_file):
        """Test streaming a file from storage."""
        driver, tmpdir = storage
        vfs_path = vpath_file_name
        await driver.upload(local_file.name, vfs_path)

        async def read_stream():
            chunks = []
            async for chunk in driver.stream(vfs_path):
                chunks.append(chunk)
            return b"".join(chunks)

        content = await read_stream()
        assert content == b"Test content"

    @pytest.mark.asyncio
    async def test_delete(self, storage, local_file):
        """Test deleting a file from storage."""
        driver, tmpdir = storage
        vfs_path = vpath_file_name
        await driver.upload(local_file.name, vfs_path)
        exists = await driver.exists(vfs_path)
        assert exists
        await driver.delete(vfs_path)
        exists = await driver.exists(vfs_path)
        assert not exists

    @pytest.mark.asyncio
    async def test_folder(self, storage):
        """Test creating and listing folders."""
        driver, tmpdir = storage
        files = await driver.list_dir("/")
        file_count = len(files)
        remote_folder_path = "/new_folder"
        await driver.create_folder(remote_folder_path)
        exists = await driver.exists(remote_folder_path, 1)
        assert exists
        files = await driver.list_dir("/")
        assert len(files) == file_count + 1, f"Expected {file_count + 1} files, got {len(files)}"
        files = await driver.list_dir("/")
        found = False
        for f in files:
            if f.display_name == "new_folder":
                found = True
                assert f.is_dir, "new folder created is not marked as dir"
                break
        assert found, "new created folder not found in list"
        await driver.delete(remote_folder_path)
        exists = await driver.exists(remote_folder_path, 1)
        assert not exists
        files = await driver.list_dir("/")
        assert len(files) == file_count, f"Expected {file_count} files after deleting folder, got {len(files)}"

    @pytest.mark.asyncio
    async def test_copy(self, storage, local_file):
        """Test copying a file."""
        driver, tmpdir = storage
        vfs_path = "/original.txt"
        await driver.upload(local_file.name, vfs_path)
        copy_vfs_path = "/copy.txt"
        await driver.copy(vfs_path, copy_vfs_path)
        exists_original = await driver.exists(vfs_path, 5)
        exists_copy = await driver.exists(copy_vfs_path, 5)
        assert exists_original
        assert exists_copy
        files = await driver.list_dir("/")
        files = [f for f in files if f.is_dir is False]
        assert len(files) >= 2, f"Expected at least 2 files, got {len(files)}"
        assert any(f.display_name == "copy.txt" for f in files)
        assert any(f.display_name == "original.txt" for f in files)

    @pytest.mark.asyncio
    async def test_move(self, storage, local_file):
        """Test moving a file."""
        driver, tmpdir = storage
        vfs_path = "/to_move.txt"
        await driver.upload(local_file.name, vfs_path)
        move_vfs_path = "/moved.txt"
        await driver.move(vfs_path, move_vfs_path)
        exists_original = await driver.exists(vfs_path, 1)
        exists_moved = await driver.exists(move_vfs_path, 5)
        assert not exists_original, "Original file should not exist after move"
        assert exists_moved, "Moved file should exist"
        files = await driver.list_dir("/")
        files = [f for f in files if f.is_dir is False]
        assert any(f.display_name == "moved.txt" for f in files)
        assert not any(f.display_name == "to_move.txt" for f in files)

    @pytest.mark.asyncio
    async def test_rename(self, storage, local_file):
        """Test renaming a file."""
        driver, tmpdir = storage
        vfs_path = "/old_name.txt"
        await driver.upload(local_file.name, vfs_path)
        await driver.rename(vfs_path, "new_name.txt")
        exists_old = await driver.exists(vfs_path, 1)
        exists_new = await driver.exists("/new_name.txt", 5)
        assert not exists_old, "Old file should not exist after rename"
        assert exists_new, "Renamed file should exist"
        files = await driver.list_dir("/")
        files = [f for f in files if f.is_dir is False]
        assert any(f.display_name == "new_name.txt" for f in files)
        assert not any(f.display_name == "old_name.txt" for f in files)

    @pytest.mark.asyncio
    async def test_rename_invalid_name(self, storage, local_file):
        """Test that renaming with path separators fails."""
        driver, tmpdir = storage
        vfs_path = "/test_file.txt"
        await driver.upload(local_file.name, vfs_path)
        with pytest.raises(ValueError, match="path separators"):
            await driver.rename(vfs_path, "subdir/new_name.txt")

    @pytest.mark.asyncio
    async def test_write_content(self, storage):
        """Test writing content directly to a file using BytesIO."""
        driver, tmpdir = storage
        vfs_path = "/written_file.txt"
        content = "Hello, this is written content!"
        content_bytes = BytesIO(content.encode("utf-8"))
        await driver.upload(content_bytes, vfs_path)
        exists = await driver.exists(vfs_path, 5)
        assert exists, "Written file should exist"
        # Read the content back
        downloaded_content = await driver.fetch(vfs_path)
        assert downloaded_content == content, f"Expected '{content}', got '{downloaded_content}'"

    @pytest.mark.asyncio
    async def test_write_overwrite(self, storage):
        """Test overwriting an existing file with new content."""
        driver, tmpdir = storage
        vfs_path = "/overwrite_test.txt"
        content1 = "Original content"
        content2 = "Updated content"
        # Write original content
        await driver.upload(BytesIO(content1.encode("utf-8")), vfs_path)
        # Overwrite with new content
        await driver.upload(BytesIO(content2.encode("utf-8")), vfs_path)
        # Verify new content
        downloaded_content = await driver.fetch(vfs_path)
        assert downloaded_content == content2, f"Expected '{content2}', got '{downloaded_content}'"

    @pytest.mark.asyncio
    async def test_nonexistent_file_stream_relative(self, storage):
        """Test that streaming non-existent relative path fails."""
        driver, tmpdir = storage

        async def read_stream():
            async for _ in driver.stream("nonexistent_file.txt"):
                pass

        with pytest.raises(FileNotFoundError):
            await read_stream()

    @pytest.mark.asyncio
    async def test_nonexistent_file_stream_absolute(self, storage):
        """Test that streaming non-existent absolute path fails."""
        driver, tmpdir = storage

        async def read_stream():
            async for _ in driver.stream("/nonexistent_file.txt"):
                pass

        with pytest.raises(FileNotFoundError):
            await read_stream()

    @pytest.mark.asyncio
    async def test_nonexistent_file_delete_absolute(self, storage):
        """Test that deleting non-existent file fails."""
        driver, tmpdir = storage
        with pytest.raises(FileNotFoundError):
            await driver.delete("/nonexistent_file.txt")

    @pytest.mark.asyncio
    async def test_upload_exception(self, storage):
        """Test that uploading from non-existent file fails."""
        driver, tmpdir = storage
        remote_file_path = "remote_test_file.txt"
        with pytest.raises(FileNotFoundError):
            await driver.upload("nonexistent_file.txt", remote_file_path)

    @pytest.mark.asyncio
    async def test_download_exception_absolute(self, storage, local_file):
        """Test that downloading non-existent file fails."""
        driver, tmpdir = storage
        with pytest.raises(FileNotFoundError):
            await driver.download("/nonexistent_file.txt", local_file.name + "_downloaded")

    @pytest.mark.asyncio
    async def test_list_dir_skips_unreadable_entries(self, storage, monkeypatch):
        """Directory listing should skip unreadable pseudo-fs entries instead of failing."""
        driver, tmpdir = storage

        good_path = os.path.join(tmpdir, "ok.txt")
        with open(good_path, "w", encoding="utf-8") as f:
            f.write("ok")

        class GoodEntry:
            name = "ok.txt"
            path = good_path

            def is_symlink(self):
                return False

            def is_file(self, follow_symlinks=True):
                return True

            def is_dir(self, follow_symlinks=True):
                return False

            def stat(self, follow_symlinks=True):
                return os.stat(self.path, follow_symlinks=follow_symlinks)

        class BadFdEntry:
            name = "8"
            path = "/dev/fd/8"

            def is_symlink(self):
                raise OSError(9, "Bad file descriptor")

        class FakeScandir:
            def __init__(self, entries):
                self._entries = entries

            def __iter__(self):
                return iter(self._entries)

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                return False

        monkeypatch.setattr(os, "scandir", lambda _path: FakeScandir([GoodEntry(), BadFdEntry()]))

        files = await driver.list_dir("/")
        names = [f.display_name for f in files]

        assert "ok.txt" in names
        assert "8" not in names

    @pytest.mark.asyncio
    async def test_list_dir_permission_denied_raises_storage_permission_error(self, storage, monkeypatch):
        """Permission denied directories should raise a dedicated storage permission error."""
        driver, tmpdir = storage

        monkeypatch.setattr(os.path, "isdir", lambda _path: True)

        def _raise_permission(_path):
            raise PermissionError(1, "Operation not permitted", _path)

        monkeypatch.setattr(os, "scandir", _raise_permission)

        with pytest.raises(StoragePermissionError, match="Permission denied"):
            await driver.list_dir("/home")


if __name__ == "__main__":
    pytest.main()
