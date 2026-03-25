# sod storage on file system.
# data auto-encrypted.
# data is saved automatically when a variable value changes.
# data is loaded automatically when the variable is accessed.
import json
import logging
import os
from typing import Any, Dict

from cryptography.fernet import Fernet
from pydantic import BaseModel, ConfigDict

from flow_sdk.config import ServiceConfig
from flow_sdk.external_apis.sod.providers.sod_provider_base import SodDriver
from flow_sdk.utils import ROOT_FOLDER


class SodFileSchema(BaseModel):
    sodot: Dict[str, Any]
    model_config = ConfigDict(from_attributes=True, arbitrary_types_allowed=True)


class FileSodStorage(SodDriver):
    def __init__(self, cfg: ServiceConfig | None = None):
        super().__init__(cfg)
        if not os.path.isabs(cfg.sod_file_name):
            self.file_path = os.path.join(ROOT_FOLDER, cfg.sod_file_name)
        else:
            self.file_path = cfg.sod_file_name
        self.cipher_suite = Fernet(cfg.sod_enc_key)

    async def _reset(self) -> any:
        if os.path.exists(self.file_path):
            os.remove(self.file_path)

    async def load_raw_sod(self, sod_name: str) -> str:
        data = self.load_file()
        if sod_name not in data.sodot:
            raise KeyError(f"Key {sod_name} not found in sod file storage")
        return data.sodot[sod_name]

    async def store_raw_sod(self, sod_name: str, value: str) -> None:
        data = self.load_file()
        data.sodot[sod_name] = value
        self.save_file(data)

    async def delete_sod(self, sod_name: str) -> any:
        data = self.load_file()
        del data.sodot[sod_name]
        self.save_file(data)

    # TODO - make this io async
    def save_file(self, data: SodFileSchema):
        try:
            json_data = data.model_dump()
            encrypted_data = self.cipher_suite.encrypt(json.dumps(json_data).encode())
            with open(self.file_path, "wb") as file:
                file.write(encrypted_data)
        except Exception as e:
            logging.error(f"Error saving data to file sod storage: {e}")

    # TODO - make this io async
    def load_file(self) -> SodFileSchema:
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
            logging.error(f"Error loading data from file sod storage: {e}")
            return {}
