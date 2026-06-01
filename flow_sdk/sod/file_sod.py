"""File-based SOD storage provider (development only).

Stores encrypted secrets in a local file.

Three construction forms:
  * ``FileSodStorage(cfg=ServiceConfig(...))`` — legacy async path, server-side
    SOD request handling. Reads sod_file_name + sod_enc_key from cfg.
  * ``FileSodStorage(key=..., file_path=...)`` — eager sync path; the Fernet
    key is known at construction time.
  * ``FileSodStorage(key_provider=..., file_path=...)`` — lazy path used by
    InstanceSettings.sod. The key is resolved on the FIRST encrypt/decrypt,
    never at construction. This is what lets an empty store be *read* without
    touching the keychain (no key needed when the file doesn't exist yet),
    so liveness probes never trigger a surprise OS keychain prompt.

Both the sync surface (``read``/``write``/``delete``/``list``/``exists``) and
the async surface (``load_raw_sod``/``store_raw_sod``/``delete_sod``) operate
on ONE file and serialize writes via ``FileLock`` on a ``<file_path>.lock``
sibling. Writes are atomic (temp + ``os.replace``).
"""

import asyncio
import json
import logging
import os
import tempfile
from pathlib import Path
from typing import Any, Callable, Dict, Optional, Union

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
        key_provider: Optional[Callable[[], Union[bytes, str]]] = None,
    ):
        """Initialize FileSodStorage.

        Args:
            cfg: ServiceConfig with sod_file_name + sod_enc_key (legacy path).
            key: Fernet key, eager (bytes or base64 str). Resolved at construction.
            key_provider: zero-arg callable returning the Fernet key, resolved
                LAZILY on first encrypt/decrypt. Never called when reading a
                store whose file doesn't exist yet (no key needed).
            file_path: Absolute path to the on-disk encrypted file.

        Raises:
            ValueError: If no key source is supplied, or sod_enc_key missing on cfg.
        """
        # ``_cipher_suite`` stays None until a key is actually needed; the lazy
        # provider is what defers the keychain hit to first real crypto.
        self._cipher_suite: Optional[Fernet] = None
        self._key_provider: Optional[Callable[[], Union[bytes, str]]] = None

        if key_provider is not None and file_path is not None:
            # Lazy construction path — used by InstanceSettings.sod.
            self.cfg = None
            self.file_path = str(file_path)
            self._key_provider = key_provider
        elif key is not None and file_path is not None:
            # Eager construction path — bypass ServiceConfig, key known now.
            self.cfg = None
            self.file_path = str(file_path)
            self._cipher_suite = Fernet(key.encode() if isinstance(key, str) else key)
        else:
            super().__init__(cfg)
            if not self.cfg.sod_enc_key:
                raise ValueError("sod_enc_key is required for FileSodStorage")
            if not os.path.isabs(self.cfg.sod_file_name):
                self.file_path = os.path.join(ROOT_FOLDER, self.cfg.sod_file_name)
            else:
                self.file_path = self.cfg.sod_file_name
            self._cipher_suite = Fernet(
                self.cfg.sod_enc_key.encode()
                if isinstance(self.cfg.sod_enc_key, str)
                else self.cfg.sod_enc_key
            )
        # ``<file>.lock`` sibling — Path.with_suffix replaces the existing
        # extension or appends .lock if there is none. Held for the full
        # read-modify-write cycle by both the sync and async write paths.
        self.lock_path = str(Path(self.file_path).with_suffix(".lock"))

    def _cipher(self) -> Fernet:
        """Resolve (once) and return the Fernet cipher.

        For the lazy ``key_provider`` form this is the single point that
        actually fetches the key (keychain or env) — invoked only when the
        store must encrypt or decrypt real bytes, never on an empty read.
        """
        if self._cipher_suite is None:
            if self._key_provider is None:
                raise ValueError("FileSodStorage has no key or key_provider")
            raw = self._key_provider()
            self._cipher_suite = Fernet(raw.encode() if isinstance(raw, str) else raw)
        return self._cipher_suite

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
            self.save_file(data)  # save_file writes atomically at mode 0o600

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
        """Store raw secret to file. Locked read-modify-write, off the loop.

        The unified store is written by both the sync (login/CLI) and async
        (server runtime) paths, so the async write must take the SAME FileLock
        the sync path uses. The blocking lock+IO runs in a thread.
        """
        await asyncio.to_thread(self._locked_store, sod_name, value)
        logger.debug(f"Stored secret: {sod_name}")

    def _locked_store(self, sod_name: str, value: str) -> None:
        with FileLock(self.lock_path):
            data = self.load_file()
            data.sodot[sod_name] = value
            self.save_file(data)

    async def delete_sod(self, sod_name: str) -> None:
        """Delete secret from file. Locked read-modify-write, off the loop."""
        await asyncio.to_thread(self._locked_delete, sod_name)

    def _locked_delete(self, sod_name: str) -> None:
        with FileLock(self.lock_path):
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
            encrypted_data = self._cipher().encrypt(json_str.encode())

            # Atomic write: one sodot file now holds login + all secrets, so a
            # torn write would lose everything. Write a temp sibling at 0o600,
            # then os.replace (atomic on the same filesystem).
            target_dir = os.path.dirname(self.file_path) or "."
            os.makedirs(target_dir, exist_ok=True)
            fd, tmp_path = tempfile.mkstemp(dir=target_dir, prefix=".sodot.", suffix=".tmp")
            try:
                with os.fdopen(fd, "wb") as file:
                    file.write(encrypted_data)
                try:
                    os.chmod(tmp_path, 0o600)
                except OSError:
                    # Best-effort — Windows / FS without chmod shouldn't fail the write.
                    pass
                os.replace(tmp_path, self.file_path)
            except Exception:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
                raise
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
                    decrypted_data = self._cipher().decrypt(encrypted_data)
                    json_data = json.loads(decrypted_data.decode())
                    return SodFileSchema.model_validate(json_data)
            else:
                # No file yet → empty store, and crucially we do NOT resolve the
                # key here. Reading a never-written store never hits the keychain.
                return SodFileSchema(sodot={})
        except Exception as e:
            logger.error(f"Error loading data from file sod storage: {e}")
            raise
