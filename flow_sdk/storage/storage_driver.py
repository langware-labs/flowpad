import logging
from abc import ABC, abstractmethod
from contextlib import asynccontextmanager
from functools import wraps
from io import BytesIO
from typing import Any, AsyncIterator, BinaryIO, List

from flow_sdk.api.fs.fs_api import VFSPath
from flow_sdk.api.type_id import TypeId

# FSEntry import is optional - it may not be defined yet in models
try:
    from flow_sdk.models import FSEntry
except ImportError:
    FSEntry = None  # Will be used for type hints only

logger = logging.getLogger(__name__)


def validate_absolute_vpath(func):
    @wraps(func)
    def wrapper(self, vfs_path: str | VFSPath, *args, **kwargs):
        vpath = vfs_path
        if isinstance(vpath, str):
            vpath = VFSPath(vpath)
        if not isinstance(vpath, VFSPath):
            raise ValueError(f"Invalid vpath: {vfs_path}")
        if not vpath.is_absolute():
            raise ValueError(f"VFSPath must be absolute: {vfs_path}")
        return func(self, vfs_path, *args, **kwargs)

    return wrapper


class StorageError(Exception):
    """Base exception class for storage-related errors."""

    pass


class StoragePermissionError(StorageError):
    """Raised when storage access is denied by OS/file-system permissions."""

    pass


class AuthenticationError(StorageError):
    """Exception raised when authentication fails."""

    pass


class StreamUploader:
    def __init__(self, io_stream: BinaryIO) -> None:
        self.fs_entry: FSEntry | None = None
        self.io_stream: BinaryIO = io_stream
        self.chunk_size = 1024 * 1024  # 1MB
        self.file_size = io_stream.seek(0, 2)  # Get file size
        io_stream.seek(0)  # Reset file pointer
        self.uploaded_size = 0

    @property
    def progress(self) -> int:
        return int(self.uploaded_size / self.file_size) * 100

    @abstractmethod
    @asynccontextmanager
    async def create_resumable_upload_session(self):
        yield

    @abstractmethod
    async def upload_next_chunk(self) -> int | None:
        pass


class StorageDriver(ABC):
    def __init__(self, mount_path: str) -> None:
        self.mount_path = mount_path
        self.driver_mount_subfolder: str | None = None
        self.storage_path_sep = "/"
        self.credentials: Any = None
        self.root_entity_typeid: TypeId | None = None
        self.initialized = False

    def subfolder_storage(self, subfolder_path: str) -> "StorageDriver":
        sub_storage = self._subfolder_storage(subfolder_path)
        sub_storage.root_entity_typeid = self.root_entity_typeid
        return sub_storage

    @abstractmethod
    def _subfolder_storage(self, subfolder_path: str) -> "StorageDriver":
        pass

    @abstractmethod
    def app2storage_path_format(self, vfs_path: str) -> str:
        pass

    @property
    def vfs_root_path(self) -> str:
        return self.get_storage_path("/")

    def get_storage_path(self, vfs_path: str) -> str:
        # logger.debug(f"get_storage_path vfs_path: {vfs_path}")
        resource_full_vfs_path = vfs_path.strip("/")
        resource_full_storage_path = self.app2storage_path_format(resource_full_vfs_path).strip(self.storage_path_sep)
        # Mount subfolders are already storage-relative, so add them only after
        # converting the application VFS locator.
        if self.driver_mount_subfolder:
            storage_subfolder = self.driver_mount_subfolder.replace("/", self.storage_path_sep).strip(
                self.storage_path_sep
            )
            resource_full_storage_path = self.storage_path_sep.join(
                part for part in (storage_subfolder, resource_full_storage_path) if part
            )
        # Add mount storage path if it exists
        if (
            self.mount_path
            and resource_full_storage_path
            and not resource_full_storage_path.startswith(self.mount_path)
        ):
            resource_storage_path = self.mount_path.rstrip(self.storage_path_sep)
            resource_full_storage_path = self.storage_path_sep.join([resource_storage_path, resource_full_storage_path])

        # Handle root path case: if result is empty but mount path was set, use mount path
        if not resource_full_storage_path and self.mount_path:
            return self.mount_path

        return resource_full_storage_path

    async def setup_storage(self, credentials: Any = None) -> None:
        if self.initialized:
            return
        self.credentials = credentials
        await self._authenticate(credentials)
        self.initialized = True

    @abstractmethod
    async def _authenticate(self, credentials: Any = None) -> None:
        """Authenticate with the storage service using the provided credentials.

        Raises:
            AuthenticationError: If authentication fails.
        """
        pass

    @abstractmethod
    async def exists(self, vfs_path: str, timeout=0) -> bool:
        """Check if a file or folder exists on the storage device.

        Args:
            vfs_path: Path to the file or folder on the storage device.
            timeout: Timeout in seconds to wait until exist.

        Returns:
            True if the file or folder exists, False otherwise.

        Raises:
            StorageError: If the existence check fails.
        """
        pass

    @abstractmethod
    async def stream_upload(self, upload_stream: BinaryIO, vfs_path: str = "/") -> StreamUploader:
        """Upload a file to the storage device.

        Args:
            upload_stream: the file stream.
            vfs_path: Destination path on the storage device.

        Raises:
            StorageError: If the upload fails.
        """
        pass

    @abstractmethod
    async def upload(self, local_file_or_io: str | BytesIO, vfs_path: str = "/") -> None:
        """Upload a file to the storage device.

        Args:
            local_file_or_io: Path to the local file.
            vfs_path: Destination path on the storage device.

        Raises:
            StorageError: If the upload fails.
        """
        pass

    @abstractmethod
    async def download(
        self, vfs_path: str, local_path: str | BytesIO, offset: int = 0, size: int | None = None
    ) -> None:
        """Download a file from the storage device.

        Args:
            vfs_path: Path to the file on the storage device.
            local_path: Destination path on the local machine.
            offset: Offset to start the download from.
            size: Size to download.

        Raises:
            StorageError: If the download fails.
        """
        pass

    @abstractmethod
    async def stream_zip(self, vfs_path: str) -> AsyncIterator[bytes]:
        """Asynchronously stream a zip file from the storage device."""
        logger.warning("non implemented stream_zip used")
        yield b""  # Dummy implementation

    @abstractmethod
    async def upload_zip(self, zip_file: BytesIO, vfs_path: str) -> None:
        """Upload a zip file to the storage device.

        Args:
            vfs_path: Destination path on the storage device.
            zip_file: The zip file to upload.
        """
        pass

    @abstractmethod
    async def stream(self, vfs_path: str) -> AsyncIterator[bytes]:
        """Asynchronously stream a file from the storage device.

        Args:
            vfs_path: Path to the file on the storage device.

        Yields:
            Chunks of the file data as bytes.

        Raises:
            StorageError: If streaming fails.
        """
        logger.warning("non implemented stream used")
        yield b""  # Dummy implementation

    async def fetch(self, vfs_path: str) -> str:
        value = b""
        async for chunk in self.stream(vfs_path):
            value += chunk
        decoded = value.decode("utf-8")
        return decoded

    @abstractmethod
    async def list_dir(self, vfs_path: str | None = None) -> List[FSEntry]:
        """List the contents of a directory on the storage device.

        Args:
            vfs_path: Path to the directory on the storage device.

        Returns:
            A list of file and directory names.

        Raises:
            StorageError: If listing fails.
        """
        pass

    @abstractmethod
    async def delete(self, vfs_path: str) -> None:
        """Delete a file or folder from the storage device.

        Args:
            vfs_path: Path to the file or directory on the storage device.

        Raises:
            StorageError: If deletion fails.
        """
        pass

    async def reset(self, del_prefix: str | None = None, skip_list: List | None = None) -> None:
        """Reset the storage device, dev only!!!"""
        return await self._reset(del_prefix, skip_list, True)

    @abstractmethod
    async def _reset(
        self, del_prefix: str | None = None, skip_list: List | None = None, ignore_not_found: bool = False
    ) -> None:
        pass

    @abstractmethod
    async def create_folder(self, vfs_path: str) -> None:
        """Create a new folder on the storage device.

        Args:
            vfs_path: Path to the new folder on the storage device.

        Raises:
            StorageError: If folder creation fails.
        """
        pass

    @abstractmethod
    async def move(self, source_vfs_path: str, destination_vfs_path: str) -> None:
        """Move a file or folder to a new location on the storage device.

        Args:
            source_vfs_path: Current path of the file or folder.
            destination_vfs_path: New path for the file or folder.

        Raises:
            StorageError: If the move operation fails.
        """
        pass

    @abstractmethod
    async def copy(self, source_vfs_path: str, destination_vfs_path: str) -> None:
        """Copy a file or folder to a new location on the storage device.

        Args:
            source_vfs_path: Virtual Path to the source file or folder.
            destination_vfs_path: Destination Virtual path on the storage device.

        Raises:
            StorageError: If the copy operation fails.
        """
        pass

    async def rename(self, vfs_path: str, new_name: str) -> None:
        """Rename a file or folder (same directory).

        This is a convenience method that uses move() internally.
        Subclasses can override for native rename support.

        Args:
            vfs_path: Virtual Path to the file or folder to rename.
            new_name: The new name (without path separators).

        Raises:
            StorageError: If the rename operation fails.
            ValueError: If new_name contains path separators.
        """
        if "/" in new_name or "\\" in new_name:
            raise ValueError("New name cannot contain path separators. Use move() instead.")

        # Calculate destination path (same parent directory)
        vfs_path = vfs_path.rstrip("/")
        parent = "/".join(vfs_path.split("/")[:-1])
        dest_path = f"{parent}/{new_name}" if parent else new_name
        await self.move(vfs_path, dest_path)
