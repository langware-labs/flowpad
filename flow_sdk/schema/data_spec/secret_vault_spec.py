"""A project's secret vaults (``docs/secret_share.md``).

A **vault** is a group of secrets in one secret manager — the unit of access. A project lists
named vaults in ``project_manifest.json`` (``secret_vaults``); each credential variable points
at ``{vault, key}`` (:class:`SecretRefSpec`). Both name a place, never a value.
"""

from __future__ import annotations

from typing import Any, ClassVar

from pydantic import Field

from flow_sdk.schema.data_spec.spec import DataSpec


class SecretVaultSpec(DataSpec):
    """One vault: which secret manager holds it and that manager's config (e.g. its vault name)."""

    spec_kind: ClassVar[str] = "secrets.project_vault"

    #: The secret manager's name — an asset folder under ``agentic-assets/secret_manager/``.
    manager: str
    #: The manager's own config for this vault (its ``config_fields``). Never a value.
    config: dict[str, Any] = Field(default_factory=dict)


class SecretRefSpec(DataSpec):
    """Where one credential variable's shared value lives: a vault the project names, and its key there."""

    vault: str
    key: str
