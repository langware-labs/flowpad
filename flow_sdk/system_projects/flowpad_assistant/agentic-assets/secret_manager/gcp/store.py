"""The ``gcp`` secret manager's store — a vault is one GCP project's secrets under a name prefix.

A thin face over the SDK's ``gcp_secret_manager`` store (``flow_sdk.secrets.gcp_secret_manager``):
the same wire, the same bound ``google`` connection; only the vault's config reads ``project``
(the manager's own field name, the one its commands substitute) rather than ``gcp_project``.
"""
from __future__ import annotations

from typing import ClassVar

from pydantic import ConfigDict, Field

from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.secrets.gcp_secret_manager import GcpSecretManagerStore
from flow_sdk.secrets.store import register_store


class GcpVaultConfig(DataSpec):
    model_config = ConfigDict(frozen=True)

    #: The project id (or number) that holds the secrets.
    project: str = Field(min_length=1, pattern=r"^[A-Za-z0-9][A-Za-z0-9-]*$")
    #: A name ``N`` lives in the secret ``<prefix>N``.
    prefix: str = Field(default="", pattern=r"^[A-Za-z0-9_-]*$")

    @property
    def gcp_project(self) -> str:
        return self.project


@register_store
class GcpVaultStore(GcpSecretManagerStore):
    type_name: ClassVar[str] = "gcp"
    config_spec: ClassVar[type[DataSpec]] = GcpVaultConfig
    config: GcpVaultConfig  # type: ignore[assignment]

    @property
    def where(self) -> str:
        return f"GCP project {self.config.project}" + (f" · {self.config.prefix}*" if self.config.prefix else "")


__all__ = ["GcpVaultConfig", "GcpVaultStore"]
