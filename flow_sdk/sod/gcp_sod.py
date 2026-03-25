"""Google Cloud Secret Manager SOD storage provider (production).

Stores secrets in Google Cloud Secret Manager.
"""

import logging
import re
from typing import Any, Optional

try:
    from google.api_core.exceptions import AlreadyExists, NotFound
    from google.cloud import secretmanager
except ImportError:
    secretmanager = None
    AlreadyExists = Exception
    NotFound = Exception

from flow_sdk.config import ServiceConfig, default_service_config
from .sod_provider_base import SodDriver

logger = logging.getLogger(__name__)


class GCSISod(SodDriver):
    """Google Cloud Secret Manager SOD storage provider (production).

    Stores all secrets in GCP Secret Manager with automatic replication.
    """

    def __init__(self, cfg: Optional[ServiceConfig] = None):
        """Initialize GCSISod.

        Args:
            cfg: ServiceConfig instance with google_cloud_project_id.

        Raises:
            ValueError: If google_cloud_project_id is not set.
        """
        super().__init__(cfg)

        if not default_service_config.google_cloud_project_id:
            raise ValueError("google_cloud_project_id is required for GCSISod")

        self.client = secretmanager.SecretManagerServiceAsyncClient()
        self.project_id = default_service_config.google_cloud_project_id
        self.parent = f"projects/{self.project_id}"
        self.delimiter = "_"

    async def _reset(self) -> None:
        """Delete all secrets with matching prefix (development only)."""
        secrets = await self.client.list_secrets(request={"parent": self.parent})
        secrets_to_delete = []

        # Asynchronously iterate over the secrets
        async for secret in secrets:
            pattern = r"^projects/\d+/secrets/" + re.escape(self.prefix) + f"{self.delimiter}[a-zA-Z0-9_]+$"
            if re.match(pattern, secret.name):
                secrets_to_delete.append(secret.name)

        # Delete each secret
        for secret_name in secrets_to_delete:
            logger.info(f"Deleting secret: {secret_name}")
            await self.client.delete_secret(request={"name": secret_name})

        logger.info("Bulk deletion completed.")

    @property
    def _sod_base_path(self) -> str:
        """Get the base path for GCS secrets."""
        return f"projects/{self.project_id}/secrets"

    def sod_gcp_id(self, name: str) -> str:
        """Get GCS-formatted secret ID.

        Args:
            name: Secret name.

        Returns:
            Formatted secret ID: {prefix}_{name}
        """
        return f"{self.prefix}{self.delimiter}{name}"

    def sod_key_path(self, name: str) -> str:
        """Get full GCS secret path.

        Args:
            name: Secret name.

        Returns:
            Full path: projects/{project}/secrets/{prefix}_{name}
        """
        return f"{self._sod_base_path}/{self.sod_gcp_id(name)}"

    async def load_raw_sod(self, sod_name: str) -> str:
        """Load raw secret from GCS.

        Args:
            sod_name: Name/key of the secret.

        Returns:
            Raw secret value.

        Raises:
            KeyError: If secret not found.
        """
        name = f"{self.sod_key_path(sod_name)}/versions/latest"

        try:
            response = await self.client.access_secret_version(request={"name": name})
            payload = response.payload.data.decode("UTF-8")
            return payload
        except NotFound:
            logger.warning(f"Secret {sod_name} not found in GCS.")
            raise KeyError("Secret not found.")
        except Exception as e:
            logger.error(f"Error accessing secret: {e}")
            raise

    async def store_raw_sod(self, sod_name: str, value: str) -> str:
        """Store raw secret to GCS.

        Args:
            sod_name: Name/key for the secret.
            value: Raw value to store.

        Returns:
            Name of created/updated secret version.
        """
        parent = self.parent

        try:
            # Create the secret if it doesn't exist
            logger.info(f"Creating secret {sod_name}...")
            await self.client.create_secret(
                request={
                    "parent": parent,
                    "secret_id": self.sod_gcp_id(sod_name),
                    "secret": {"replication": {"automatic": {}}},
                }
            )
            logger.info(f"Secret {sod_name} created successfully.")
        except AlreadyExists:
            logger.info(f"Secret {sod_name} already exists. Updating secret.")
        except Exception as e:
            logger.error(f"Error creating secret: {e}")
            raise

        try:
            # Add a new version with the provided payload
            response = await self.client.add_secret_version(
                request={
                    "parent": self.sod_key_path(sod_name),
                    "payload": {"data": value.encode("UTF-8")},
                }
            )
            logger.info(f"Secret version for {sod_name} added successfully.")
            return response.name
        except Exception as e:
            logger.error(f"Error adding secret version: {e}")
            raise

    async def delete_sod(self, sod_name: str) -> None:
        """Delete secret from GCS.

        Args:
            sod_name: Name/key of the secret to delete.

        Raises:
            KeyError: If secret not found.
        """
        try:
            await self.client.delete_secret(request={"name": self.sod_key_path(sod_name)})
            logger.info(f"Deleted secret: {sod_name}")
        except NotFound:
            logger.warning(f"Secret {sod_name} not found in GCS.")
            raise KeyError("Secret not found.")
        except Exception as e:
            logger.error(f"Error deleting secret: {e}")
            raise
