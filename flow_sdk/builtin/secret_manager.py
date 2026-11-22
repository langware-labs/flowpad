"""SecretManager — the indexed row of a secret manager (``agentic-assets/secret_manager/<name>/``).

The run-time side is ``flow_sdk/secrets/managers.py``: it loads the shipped folders, runs their
commands and builds a ``SecretStore`` over one vault. A VAULT is one configured instance of a
manager (``SecretVaultSpec``); the manager renders the instructions an agent using that vault gets.
"""
from __future__ import annotations

from typing import Any, ClassVar, Optional

from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.core import Entity
from flow_sdk.schema.data_spec.secret_manager_spec import ConfigFieldSpec, OsCommandsSpec
from flow_sdk.schema.types import EntityType


class SecretManager(Entity):
    """The ROW; its shape on disk is ``SecretManagerSpec`` (``TypeInfo.asset_spec``)."""

    type: str = APIField(default=EntityType.SECRET_MANAGER.value)

    # A folder-backed asset owns its path. PRIVATE: the path is this machine's.
    asset_ref: Optional[str] = APIField(None, sharing=Sharing.PRIVATE)

    title: str = APIField(default="")
    description: str = APIField(default="")
    icon: str = APIField(default="")
    config_fields: list[ConfigFieldSpec] = APIField(default_factory=list)
    # The manifest's commands, held on the row because the spec IS the field list.
    install: OsCommandsSpec = APIField(default_factory=OsCommandsSpec)
    login: OsCommandsSpec = APIField(default_factory=OsCommandsSpec)
    check: str = APIField(default="")
    grant: str = APIField(default="")
    status: str = APIField(default="")
    close: str = APIField(default="")
    env: dict[str, str] = APIField(default_factory=dict)
    login_help: str = APIField(default="")

    _api_visible: ClassVar[bool] = True

    def system_instructions(self, vault: Any, *, name: str = "") -> str:
        """What an agent using ``vault`` (one of this manager's) is told — the manager's own
        ``instructions.md`` with the vault's config filled in. Runs no command."""
        from flow_sdk.secrets import managers  # noqa: PLC0415  (lazy: managers load assets)

        return managers.instructions_for(vault, name=name)
