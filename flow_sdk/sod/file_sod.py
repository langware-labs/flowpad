"""File-based SOD storage provider (development only).

Stores encrypted secrets in a local file.
"""

import json
import logging
import os
from typing import Any, Dict, Optional

from cryptography.fernet import Fernet
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

    def __init__(self, cfg: Optional[ServiceConfig] = None):
        """Initialize FileSodStorage.

        Args:
            cfg: ServiceConfig instance with sod_file_name and sod_enc_key.

        Raises:
            ValueError: If sod_enc_key is not provided.
        """
        super().__init__(cfg)

        if not self.cfg.sod_enc_key:
            raise ValueError("sod_enc_key is required for FileSodStorage")

        # Resolve file path
        if not os.path.isabs(self.cfg.sod_file_name):
            self.file_path = os.path.join(ROOT_FOLDER, self.cfg.sod_file_name)
        else:
            self.file_path = self.cfg.sod_file_name

        # Initialize cipher
        self.cipher_suite = Fernet(self.cfg.sod_enc_key.encode() if isinstance(self.cfg.sod_enc_key, str) else self.cfg.sod_enc_key)

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
