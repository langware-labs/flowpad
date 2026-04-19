import errno
import logging
import os
import shutil
import sys
from contextlib import asynccontextmanager
from io import BytesIO
from typing import Any, AsyncIterator, BinaryIO, List

import anyio
from starlette.concurrency import run_in_threadpool

# FSItem import is optional - it may not be defined yet in models
try:
    from flow_sdk.models import FSItem
except ImportError:
    FSItem = None  # Will be used for type hints only

from flow_sdk.storage.storage_driver import StorageDriver, StorageError, StoragePermissionError, StreamUploader, VFSPath

logger = logging.getLogger(__name__)


def to_os_path(unix_path) -> str:
    unix_path = unix_path.lstrip("/").lstrip("./")
    parts = list(filter(None, unix_path.split("/")))
    if not parts:
        return "."
    return str(os.path.join(*parts))  # noqa


def compare_paths(path1, path2):
    """
    Compares two filesystem paths for equality, considering filesystem norms.

    Args:
    path1 (str): First path to compare.
    path2 (str): Second path to compare.

    Returns:
    bool: True if paths are considered equal, False otherwise.
    """
    # Normalize both paths
    norm1 = os.path.normpath(os.path.abspath(path1))
    norm2 = os.path.normpath(os.path.abspath(path2))

    # Optionally normalize case (useful on Windows)
    if os.name == "nt":  # nt means Windows
        norm1 = os.path.normcase(norm1)
        norm2 = os.path.normcase(norm2)

    # Compare normalized paths
    return norm1 == norm2


class LocalStreamUploader(StreamUploader):
    def __init__(self, local_file_storage_path: str, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.local_file_path = local_file_storage_path
        self.local_file_handler = None

    @asynccontextmanager
    async def create_resumable_upload_session(self):
        self.local_file_handler = await anyio.open_file(self.local_file_path, "wb")
        yield

    async def upload_next_chunk(self) -> int | None:
        if not self.local_file_handler:
            raise Exception("No local file handler found")
        chunk = await run_in_threadpool(self.io_stream.read, self.chunk_size)
        if not chunk:
            await self.local_file_handler.aclose()
            return 0
        written = await self.local_file_handler.write(chunk)
        self.uploaded_size += written
        return written


async def delete_folder_content(folder_path: str, skip_list: List | None = None, ignore_not_found: bool = False):
    """
    Deletes all contents within the specified folder, including subfolders, but skips
    files or directories containing the specified string in their name.

    Parameters:
    - folder_path (str): Path to the folder whose contents are to be deleted.
    - skip_string (str): String to look for in file or directory names to skip them.
    - ignore_not_found (bool): If True, ignore FileNotFoundError exceptions.

    Raises:
    - FileNotFoundError: If the folder does not exist and not set to ignore_not_found.
    - NotADirectoryError: If the path is not a directory.
    """
    # Check if the folder exists and is a directory
    folder = anyio.Path(folder_path)
    if not await folder.exists():
        if ignore_not_found:
            return
        raise FileNotFoundError(f"Folder not found: {folder_path}")
    if not await folder.is_dir():
        raise NotADirectoryError(f"Path is not a directory: {folder_path}")

    # Recursive deletion logic
    async for item in folder.iterdir():
        # Skip items containing the skip_string in their name
        to_skip = any(skip in item.name for skip in skip_list or [])
        if to_skip:
            continue

        # Handle files, symlinks, and directories
        if await item.is_file() or await item.is_symlink():
            await item.unlink()
        elif await item.is_dir():
            # Recursively call delete_folder_content for subfolders
            await delete_folder_content(str(item), skip_list)
            # Remove the now-empty directory
            remaining_items = [f async for f in item.iterdir()]
            if not remaining_items:  # Directory is empty
                await item.rmdir()


class LocalStorageDriver(StorageDriver):
    def __init__(self, mount_path: str) -> None:
        super().__init__(mount_path)
        self.storage_path_sep = os.path.sep

    def _subfolder_storage(self, subfolder_path: str) -> "StorageDriver":
        cloned_driver = LocalStorageDriver(self.mount_path)
        current_subfolder = self.driver_mount_subfolder or ""
        new_subfolder = "/".join([current_subfolder, subfolder_path])
        cloned_driver.driver_mount_subfolder = new_subfolder
        return cloned_driver

    def app2storage_path_format(self, vfs_path: str) -> str:
        vpath = VFSPath(vfs_path)
        if vpath.entity_sub_path is None:
            raise ValueError(f"Invalid vfs path: {vfs_path}")
        return vpath.entity_sub_path.replace("/", self.storage_path_sep)

    async def _authenticate(self, credentials: Any = None) -> None:
        """Local file system does not require authentication."""
        pass  # No authentication needed for local file system

    def _local_full_path(self, vfs_path: str) -> str:
        relative_vpath = vfs_path
        vpath = VFSPath(vfs_path)
        if vpath.is_absolute():
            relative_vpath = vpath.entity_subpath
        # If entity_subpath is already an absolute OS path (e.g. C:/Users/... on Windows),
        # return it directly — joining with mount_path would double-prefix the drive letter.
        if os.path.isabs(relative_vpath):
            return os.path.normpath(relative_vpath)
        return self.get_storage_path(relative_vpath)
        # rel_os_path = to_os_path(storage_path)
        # return str(os.path.join(self.mount.storage_path, rel_os_path))

    async def exists(self, vfs_path: str, timeout=0) -> bool:
        """Check if a file or folder exists on the storage device."""
        try:
            while True:
                storage_local_path = self._local_full_path(vfs_path)
                if os.path.exists(storage_local_path):
                    return True
                if timeout <= 0:
                    break
                await anyio.sleep(1)
                timeout -= 1
            return False
        except Exception as e:
            raise StorageError(f"Failed to check existence: {e}")

    async def stream_upload(self, upload_stream: BinaryIO, vfs_path: str = "/") -> StreamUploader:
        storage_local_path = self._local_full_path(vfs_path)
        local_storage_file_folder = anyio.Path(storage_local_path).parent  # Get the directory part of the path
        await anyio.Path(local_storage_file_folder).mkdir(parents=True, exist_ok=True)
        uploader = LocalStreamUploader(local_file_storage_path=storage_local_path, io_stream=upload_stream)
        logger.debug(f"LocalStreamUploader created for {storage_local_path}")
        return uploader

    async def upload(self, local_file_or_io: str | BytesIO, vfs_path: str = "/") -> None:
        """Upload a file to the storage device (copy locally)."""
        try:
            storage_local_path = self._local_full_path(vfs_path)
            local_storage_file_folder = anyio.Path(storage_local_path).parent  # Get the directory part of the path
            await anyio.Path(local_storage_file_folder).mkdir(parents=True, exist_ok=True)
            if isinstance(local_file_or_io, str):
                shutil.copy2(local_file_or_io, storage_local_path)
            elif isinstance(local_file_or_io, BytesIO):
                async with await anyio.open_file(storage_local_path, "wb") as f:
                    await f.write(local_file_or_io.read())
            else:
                raise ValueError("Invalid file type for upload")
        except FileNotFoundError as e:
            raise e
        except Exception as e:
            raise StorageError(f"Failed to upload local file: {e}") from e

    async def download(
        self, vfs_path: str, local_path: str | BytesIO, offset: int = 0, size: int | None = None
    ) -> None:
        """Download a file from the storage device (copy locally)."""
        try:
            storage_local_path = self._local_full_path(vfs_path)
            if isinstance(local_path, str):
                async with (
                    await anyio.open_file(storage_local_path, "rb") as src_file,
                    await anyio.open_file(local_path, "wb") as dst_file,
                ):
                    await src_file.seek(offset)
                    data = await src_file.read(size or -1)
                    await dst_file.write(data)
            elif isinstance(local_path, BytesIO):
                async with await anyio.open_file(storage_local_path, "rb") as f:
                    await f.seek(offset)
                    local_path.write(await f.read(size or -1))
            else:
                raise ValueError("Invalid file type for download")
        except FileNotFoundError as e:
            raise e
        except Exception as e:
            raise StorageError(f"Failed to download file: {e}")

    async def stream_zip(self, vfs_path: str):
        """Asynchronously stream a zip file from the storage device."""
        raise NotImplementedError("stream_zip is not implemented for local storage")

    async def upload_zip(self, zip_file: BinaryIO, vfs_path: str):
        """Upload a zip file to the storage device."""
        raise NotImplementedError("stream_upload_zip is not implemented for local storage")

    async def stream(self, vfs_path: str) -> AsyncIterator[bytes]:
        """Asynchronously stream a file from the storage device."""
        storage_local_path = self._local_full_path(vfs_path)
        if not os.path.isfile(storage_local_path):
            stream_folder = str(anyio.Path(storage_local_path).parent)
            if not os.path.exists(stream_folder):
                raise FileNotFoundError(f"File to stream, Folder not found on local: {stream_folder}")
            folder_content = os.listdir(stream_folder)
            logger.debug(f"Missing file folder content: {folder_content}")
            raise FileNotFoundError(f"File to stream not found on local: {storage_local_path}")

        try:
            async with await anyio.open_file(storage_local_path, "rb") as f:
                yield await f.read()

        except FileNotFoundError as e:
            raise e
        except Exception as e:
            raise StorageError(f"Failed to stream file: {e}")

    def get_storage_path(self, vfs_path: str) -> str:
        # On Windows, absolute vfs_paths (e.g. "C:\...") must be returned as-is
        # because the base class path-joining logic would mangle them.
        # Relative paths go through the base class which handles mount_path correctly.
        if sys.platform == "win32" and os.path.isabs(vfs_path):
            return os.path.normpath(vfs_path)
        return super().get_storage_path(vfs_path)

    async def list_dir(self, vfs_path: str | None = None) -> List[FSItem]:
        """List the contents of a directory on the storage device."""
        if vfs_path is None:
            vfs_path = "/"
        storage_local_path = self._local_full_path(vfs_path)

        # Extract the entity sub-path (strip typeid prefix if present)
        # This prevents double-prefixing when constructing item paths
        parsed_vpath = VFSPath(vfs_path)
        entity_sub_path = parsed_vpath.entity_subpath if parsed_vpath.is_absolute() else vfs_path

        if not os.path.isdir(storage_local_path):
            return []
        items = []
        try:
            with os.scandir(storage_local_path) as entries:
                for entry in entries:
                    try:
                        # Check symlink first (before is_file/is_dir)
                        is_symlink = entry.is_symlink()
                        symlink_target = None

                        if is_symlink:
                            try:
                                symlink_target = os.readlink(entry.path)
                            except OSError:
                                continue  # Skip unreadable symlinks

                        is_file = entry.is_file(follow_symlinks=False)
                        is_dir = entry.is_dir(follow_symlinks=False)
                        if not (is_file or is_dir or is_symlink):
                            continue

                        # Use follow_symlinks=False to get symlink's own stat
                        stat = entry.stat(follow_symlinks=False)
                        if entity_sub_path.strip("/"):
                            item_relative_path = entity_sub_path.rstrip("/") + "/" + entry.name
                        else:
                            item_relative_path = entry.name
                        # Construct vfs_abs_path with entity typeid prefix
                        if self.root_entity_typeid:
                            item_vfs_path = f"{self.root_entity_typeid}/{item_relative_path}"
                        else:
                            item_vfs_path = item_relative_path
                        try:
                            is_directory = entry.is_dir() if not is_symlink else os.path.isdir(entry.path)
                        except OSError:
                            # Some pseudo-fs entries (e.g. /dev/fd/*) can fail while probing.
                            is_directory = False
                        item = FSItem(
                            vfs_abs_path=item_vfs_path,
                            is_dir=is_directory,
                            size=None if is_directory else stat.st_size,
                            last_modified=int(stat.st_mtime),
                            symlink_target=symlink_target,
                            display_name=entry.name,
                        )
                        items.append(item)
                    except OSError:
                        # Skip unstable pseudo-fs entries that can't be inspected.
                        continue
            return items
        except FileNotFoundError as e:
            raise e
        except OSError as e:
            # Some paths can exist but still be inaccessible to the current process.
            # Surface this as a dedicated permission error so API handlers can map to 403.
            if e.errno in (errno.EACCES, errno.EPERM):
                raise StoragePermissionError(f"Permission denied: {storage_local_path}") from e
            raise StorageError(f"Error accessing directory {storage_local_path}: {e}")

    async def delete(self, vfs_path: str) -> None:
        """Delete a file or folder from the storage device."""
        try:
            storage_local_path = self._local_full_path(vfs_path)
            if compare_paths(storage_local_path, self.mount_path):
                raise StorageError("Cannot delete root directory")
            if os.path.isfile(storage_local_path) or os.path.islink(storage_local_path):
                os.remove(storage_local_path)
            elif os.path.isdir(storage_local_path):
                if compare_paths(storage_local_path, self.mount_path):
                    await delete_folder_content(storage_local_path)
                else:
                    shutil.rmtree(storage_local_path)
            else:
                raise FileNotFoundError(f"Path not found: {storage_local_path} in {self.mount_path}")
        except FileNotFoundError as e:
            raise e
        except Exception as e:
            raise StorageError(f"Failed to delete: {e}")

    async def _reset(
        self, del_prefix: str | None = None, skip_list: List | None = None, ignore_not_found: bool = False
    ) -> None:
        await delete_folder_content(self.mount_path, skip_list, ignore_not_found)

    async def create_folder(self, vfs_path: str) -> None:
        """Create a new folder on the storage device."""
        try:
            storage_local_path = self._local_full_path(vfs_path)
            os.makedirs(storage_local_path, exist_ok=True)
        except FileNotFoundError as e:
            raise e
        except Exception as e:
            raise StorageError(f"Failed to create folder: {e}")

    async def move(self, source_vfs_path: str, destination_vfs_path: str) -> None:
        """Move a file or folder to a new location on the storage device."""
        try:
            storage_source_path = self._local_full_path(source_vfs_path)
            storage_destination_path = self._local_full_path(destination_vfs_path)
            shutil.move(storage_source_path, storage_destination_path)
        except FileNotFoundError as e:
            raise e
        except Exception as e:
            raise StorageError(f"Failed to move: {e}")

    async def copy(self, source_vfs_path: str, destination_vfs_path: str) -> None:
        """Copy a file or folder to a new location on the storage device."""
        try:
            local_source_path = self._local_full_path(source_vfs_path)
            local_destination_path = self._local_full_path(destination_vfs_path)
            if os.path.isdir(local_source_path):
                shutil.copytree(local_source_path, local_destination_path)
            else:
                shutil.copy2(local_source_path, local_destination_path)
        except FileNotFoundError as e:
            raise e
        except Exception as e:
            raise StorageError(f"Failed to copy: {e}")

    async def create_symlink(self, target_path: str, symlink_path: str, relative: bool = True) -> None:
        """Create a symbolic link.

        Args:
            target_path: Path to target (can be VFS path or absolute system path)
            symlink_path: VFS path where symlink will be created
            relative: If True, create relative symlink; if False, absolute

        Raises:
            StorageError: If symlink creation fails
            FileNotFoundError: If target_path does not exist
        """
        try:
            symlink_storage_path = self._local_full_path(symlink_path)

            # Determine if target_path is an absolute system path or a VFS path
            # Absolute system paths on Unix start with '/' and have multiple segments (e.g., /Users/...)
            # Absolute system paths on Windows contain ':' (e.g., C:\...)
            # VFS paths like "/file.txt" or "/folder/file.txt" should be converted
            is_absolute_system_path = (
                (":" in target_path)  # Windows absolute path
                or (
                    target_path.startswith("/") and target_path.count("/") > 2 and not target_path.startswith("//")
                )  # Unix absolute path with depth
            )

            if is_absolute_system_path:
                target_storage_path = target_path
            else:
                target_storage_path = self._local_full_path(target_path)

            # Validate target exists (required by user)
            if not os.path.exists(target_storage_path):
                raise FileNotFoundError(f"Target does not exist: {target_storage_path}")

            # Create parent directory
            symlink_dir = anyio.Path(symlink_storage_path).parent
            await symlink_dir.mkdir(parents=True, exist_ok=True)

            # Calculate link target
            if relative:
                link_target = os.path.relpath(target_storage_path, os.path.dirname(symlink_storage_path))
            else:
                link_target = os.path.abspath(target_storage_path)

            await run_in_threadpool(os.symlink, link_target, symlink_storage_path)

        except FileNotFoundError as e:
            raise e
        except Exception as e:
            raise StorageError(f"Failed to create symlink: {e}")

    async def resolve_symlink(self, symlink_path: str) -> str:
        """Resolve a symbolic link to its target path.

        Args:
            symlink_path: VFS path to the symlink

        Returns:
            The target path (absolute path in storage system)

        Raises:
            StorageError: If path is not a symlink or resolution fails
            FileNotFoundError: If symlink does not exist
        """
        try:
            symlink_storage_path = self._local_full_path(symlink_path)

            if not os.path.exists(symlink_storage_path):
                raise FileNotFoundError("Symlink not found")
            if not os.path.islink(symlink_storage_path):
                raise StorageError("Path is not a symlink")

            # Read symlink (doesn't follow it)
            target_path = await run_in_threadpool(os.readlink, symlink_storage_path)

            # Convert relative to absolute
            if not os.path.isabs(target_path):
                symlink_dir = os.path.dirname(symlink_storage_path)
                target_path = os.path.abspath(os.path.join(symlink_dir, target_path))

            return target_path

        except FileNotFoundError as e:
            raise e
        except Exception as e:
            raise StorageError(f"Failed to resolve symlink: {e}")

    async def is_symlink(self, vfs_path: str) -> bool:
        """Check if a path is a symbolic link.

        Args:
            vfs_path: Path to check

        Returns:
            True if path is a symlink, False otherwise

        Raises:
            StorageError: If the check fails
        """
        try:
            storage_local_path = self._local_full_path(vfs_path)
            return await run_in_threadpool(os.path.islink, storage_local_path)
        except Exception as e:
            raise StorageError(f"Failed to check symlink: {e}")
