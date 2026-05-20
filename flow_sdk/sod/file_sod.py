"""File-based SOD storage provider (development only).

Stores encrypted secrets in a local file.

Two construction forms:
  * ``FileSodStorage(cfg=ServiceConfig(...))`` — legacy async path, server-side
    SOD request handling. Reads sod_file_name + sod_enc_key from cfg.
  * ``FileSodStorage(key=..., file_path=...)`` — sync path used by
    InstanceSettings.sod. Bypasses ServiceConfig so it can be constructed
    from a per-instance Fernet key without the rest of the service config
    machinery.

The sync method surface (``read``/``write``/``delete``/``list``/``exists``)
is the canonical instance.sod API. It serializes concurrent writes via
``FileLock`` on a ``<file_path>.lock`` sibling. Existing async methods are
unchanged.
"""

import json
import logging
import os
from pathlib import Path
from typing import Any, Dict, Optional, Union

from cryptography.fernet import Fernet
from filelock import FileLock
from pydantic import BaseModel, ConfigDict

from flow_sdk.config import ServiceConfig
from flow_sdk.utils import ROOT_FOLDER
from .sod_provider_base import SodDriver

logger = logging.getLogger(__name__)


class SodFileSchema(BaseModel):
    """Schema for SOD file storage."""
    sodot: Dict[str, Any] = {}
    model_config = ConfigDict(from_attributes=True, arbitrary_types_allowed=True)


class FileSodStorage(SodDriver):
    """Local encrypted file-based SOD storage (development only).

    Stores all secrets in a single encrypted file using Fernet encryption.
    Data is automatically encrypted on save and decrypted on load.
    """

    def __init__(
        self,
        cfg: Optional[ServiceConfig] = None,
        *,
        key: Union[bytes, str, None] = None,
        file_path: Union[Path, str, None] = None,
    ):
        """Initialize FileSodStorage.

        Args:
            cfg: ServiceConfig instance with sod_file_name and sod_enc_key
                (legacy async path).
            key: Fernet key (sync path). Either bytes or base64-encoded str.
            file_path: Absolute path to the on-disk encrypted file (sync path).

        Raises:
            ValueError: If neither (cfg) nor (key + file_path) are supplied,
                or if sod_enc_key is missing on the cfg path.
        """
        if key is not None and file_path is not None:
            # Sync construction path — bypass ServiceConfig.
            # The sync surface (read/write/...) doesn't need cfg.
            self.cfg = None
            self.file_path = str(file_path)
            self.cipher_suite = Fernet(key.encode() if isinstance(key, str) else key)
        else:
            super().__init__(cfg)
            if not self.cfg.sod_enc_key:
                raise ValueError("sod_enc_key is required for FileSodStorage")
            if not os.path.isabs(self.cfg.sod_file_name):
                self.file_path = os.path.join(ROOT_FOLDER, self.cfg.sod_file_name)
            else:
                self.file_path = self.cfg.sod_file_name
            self.cipher_suite = Fernet(
                self.cfg.sod_enc_key.encode()
                if isinstance(self.cfg.sod_enc_key, str)
                else self.cfg.sod_enc_key
            )
        # ``<file>.lock`` sibling — Path.with_suffix replaces the existing
        # extension or appends .lock if there is none. Used by the sync write
        # path; the async path doesn't read this attribute but we set it
        # uniformly so the same instance can be driven from either side.
        self.lock_path = str(Path(self.file_path).with_suffix(".lock"))

    # ------------------------------------------------------------------
    # Sync API — the surface used by InstanceSettings.sod.
    # Each write op holds the FileLock for the full read-modify-write cycle.
    # ------------------------------------------------------------------

    def read(self, name: str) -> Optional[str]:
        """Return the stored value for ``name`` or None if absent."""
        if not os.path.exists(self.file_path):
            return None
        return self.load_file().sodot.get(name)

    def write(self, name: str, value: str) -> None:
        """Store ``value`` under ``name`` (overwrites if present)."""
        with FileLock(self.lock_path):
            data = self.load_file()
            data.sodot[name] = value
            self.save_file(data)
            try:
                os.chmod(self.file_path, 0o600)
            except OSError:
                # Best-effort — Windows / weird FS where chmod isn't honored
                # shouldn't fail the write.
                pass

    def delete(self, name: str) -> None:
        """Remove ``name`` if present. No-op if absent."""
        with FileLock(self.lock_path):
            if not os.path.exists(self.file_path):
                return
            data = self.load_file()
            if name in data.sodot:
                del data.sodot[name]
                self.save_file(data)

    def list(self) -> list[str]:
        """Return the stored names (unordered)."""
        if not os.path.exists(self.file_path):
            return []
        return list(self.load_file().sodot.keys())

    def exists(self, name: str) -> bool:
        """True iff ``name`` is stored."""
        if not os.path.exists(self.file_path):
            return False
        return name in self.load_file().sodot

    async def _reset(self) -> None:
        """Delete the SOD file (development only)."""
        if os.path.exists(self.file_path):
            os.remove(self.file_path)
            logger.info(f"Deleted SOD file: {self.file_path}")

    async def load_raw_sod(self, sod_name: str) -> str:
        """Load raw secret from file.

        Args:
            sod_name: Name/key of the secret.

        Returns:
            Raw encrypted value.

        Raises:
            KeyError: If secret not found.
        """
        data = self.load_file()
        if sod_name not in data.sodot:
            raise KeyError(f"Key {sod_name} not found in sod file storage")
        return data.sodot[sod_name]

    async def store_raw_sod(self, sod_name: str, value: str) -> None:
        """Store raw secret to file.

        Args:
            sod_name: Name/key for the secret.
            value: Raw value to store.
        """
        data = self.load_file()
        data.sodot[sod_name] = value
        self.save_file(data)
        logger.debug(f"Stored secret: {sod_name}")

    async def delete_sod(self, sod_name: str) -> None:
        """Delete secret from file.

        Args:
            sod_name: Name/key of the secret to delete.
        """
        data = self.load_file()
        if sod_name in data.sodot:
            del data.sodot[sod_name]
            self.save_file(data)
            logger.debug(f"Deleted secret: {sod_name}")

    def save_file(self, data: SodFileSchema) -> None:
        """Encrypt and save SOD data to file.

        Args:
            data: SodFileSchema instance to save.
        """
        try:
            json_data = data.model_dump()
            json_str = json.dumps(json_data)
            encrypted_data = self.cipher_suite.encrypt(json_str.encode())

            # Ensure directory exists
            os.makedirs(os.path.dirname(self.file_path) or ".", exist_ok=True)

            with open(self.file_path, "wb") as file:
                file.write(encrypted_data)
        except Exception as e:
            logger.error(f"Error saving data to file sod storage: {e}")
            raise

    def load_file(self) -> SodFileSchema:
        """Load and decrypt SOD data from file.

        Returns:
            SodFileSchema instance with decrypted data.
        """
        try:
            if os.path.exists(self.file_path):
                with open(self.file_path, "rb") as file:
                    encrypted_data = file.read()
                    decrypted_data = self.cipher_suite.decrypt(encrypted_data)
                    json_data = json.loads(decrypted_data.decode())
                    return SodFileSchema.model_validate(json_data)
            else:
                return SodFileSchema(sodot={})
        except Exception as e:
            logger.error(f"Error loading data from file sod storage: {e}")
            raise
