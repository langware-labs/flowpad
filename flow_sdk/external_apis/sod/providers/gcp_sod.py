import logging
import re
from typing import Any

from google.api_core.exceptions import AlreadyExists, NotFound
from google.cloud import secretmanager

from flow_sdk.config import ServiceConfig, default_service_config
from flow_sdk.external_apis.sod.providers.sod_provider_base import SodDriver


class GCSISod(SodDriver):
    def __init__(self, cfg: ServiceConfig | None = None):
        super().__init__(cfg)
        self.client = secretmanager.SecretManagerServiceAsyncClient()
        self.project_id = default_service_config.google_cloud_project_id
        self.parent = f"projects/{self.project_id}"
        self.delimiter = "_"

    async def _reset(self) -> Any:
        secrets = await self.client.list_secrets(request={"parent": self.parent})
        secrets_to_delete = []
        # Asynchronously iterate over the secrets
        async for secret in secrets:
            pattern = r"^projects/\d+/secrets/" + self.prefix + f"{self.delimiter}[a-zA-Z0-9_]+$"
            if re.match(pattern, secret.name):
                secrets_to_delete.append(secret.name)

        # Delete each secret
        for secret_name in secrets_to_delete:
            logging.info(f"Deleting secret: {secret_name}")
            await self.client.delete_secret(request={"name": secret_name})

        logging.info("Bulk deletion completed.")

    @property
    def _sod_base_path(self):
        return f"projects/{self.project_id}/secrets"

    def sod_gcp_id(self, name: str):
        return f"{self.prefix}{self.delimiter}{name}"

    def sod_key_path(self, name: str):
        return f"{self._sod_base_path}/{self.sod_gcp_id(name)}"

    async def load_raw_sod(self, sod_name: str) -> str:
        """
        Reads a secret (sod) from Google Cloud Secret Manager.
        """
        # Build the resource name of the secret version.
        name = f"{self.sod_key_path(sod_name)}/versions/latest"

        try:
            # Access the secret version.
            response = await self.client.access_secret_version(request={"name": name})

            # Decode and return the secret payload.
            payload = response.payload.data.decode("UTF-8")
            return payload
        except NotFound:
            logging.warning(f"Secret {sod_name} not found.")
            raise KeyError("Secret not found.")
        except Exception as e:
            logging.error(f"Error accessing secret: {e}")
            raise e

    async def store_raw_sod(self, sod_name: str, value: str) -> str:
        """
        Writes a secret (sod) to Google Cloud Secret Manager.
        """
        parent = self.parent

        try:
            # Create the secret if it doesn't exist, still need to add a version
            logging.info(f"Creating secret {sod_name}...")
            await self.client.create_secret(
                request={
                    "parent": parent,
                    "secret_id": self.sod_gcp_id(sod_name),
                    "secret": {"replication": {"automatic": {}}},
                }
            )
            logging.info(f"Secret {sod_name} created successfully.")
        except AlreadyExists:
            logging.info(f"Secret {sod_name} already exists. Updating secret.")

        try:
            # Add a new version with the provided payload.
            response = await self.client.add_secret_version(
                request={
                    "parent": self.sod_key_path(sod_name),
                    "payload": {"data": value.encode("UTF-8")},
                }
            )
            logging.info(f"Secret version for {sod_name} added successfully.")
            return response.name
        except Exception as e:
            logging.error(f"Error adding secret version: {e}")
            raise e

    async def delete_sod(self, sod_name: str) -> Any:
        try:
            await self.client.delete_secret(request={"name": self.sod_key_path(sod_name)})
        except NotFound:
            logging.warning(f"Secret {sod_name} not found.")
            raise KeyError("Secret not found.")
        except Exception as e:
            logging.error(f"Error deleting secret version: {e}")
            raise e
