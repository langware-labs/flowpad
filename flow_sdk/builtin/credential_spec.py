"""CredentialSpec — a named set of environment variables, and the only way to
declare secrets.

Where the folder lives is the declaration's scope, using the asset scopes
Flowpad already has:

* ``<project>/agentic-assets/credential/<name>/`` — declared for that project.
* ``~/agentic-assets/credential/<name>/`` — declared for the user (every project
  on this machine).
* the shipped assistant project — ``system`` scope, a read-only TEMPLATE that
  declares nothing until it is added to one of the two scopes above.

Where the values live is ``value_store``: the scope's ``.env.local`` or the
encrypted vault (``credential_contract``). The manifest is value-free,
structurally: every parse runs through ``assert_value_free``.
"""
from __future__ import annotations

from typing import Any, ClassVar, Optional

from pydantic import field_validator

from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.core import Entity
from flow_sdk.schema.data_spec.credential_contract import SCOPE_SYSTEM, VALUE_STORE_ENV
from flow_sdk.schema.data_spec.credential_manifest_spec import (
    CURRENT_SCHEMA,
    CredentialVarSpec,
)
from flow_sdk.schema.types import EntityType


class CredentialSpec(Entity):
    """The ROW; its shape on disk is ``CredentialManifestSpec`` (``TypeInfo.asset_spec``)."""

    type: str = APIField(default=EntityType.CREDENTIAL_SPEC.value)

    # A folder-backed asset, so it OWNS its path. PRIVATE: the path is this
    # machine's and means nothing to a receiver.
    asset_ref: Optional[str] = APIField(None, sharing=Sharing.PRIVATE)

    title: str = APIField(default="")
    description: str = APIField(default="")
    icon_name: str = APIField(default="")
    manifest_schema: int = APIField(default=CURRENT_SCHEMA)
    help_url: str = APIField(default="")
    setup_wiki: str = APIField(default="")
    value_store: str = APIField(default=VALUE_STORE_ENV)
    lm_provider: str = APIField(default="")
    vars: dict[str, CredentialVarSpec] = APIField(default_factory=dict)

    _api_visible: ClassVar[bool] = True

    @field_validator("vars", mode="before")
    @classmethod
    def _project_vars(cls, value: Any) -> Any:
        """Read each variable field by field, dropping keys the model does not name.

        A row indexed by an earlier build can carry fields that no longer exist
        (``sod_name``). The manifest is still strict — ``CredentialManifestSpec``
        rejects them on disk — but a stored row must stay readable, or one stale
        row fails every credential query.
        """
        if not isinstance(value, dict):
            return value
        known = set(CredentialVarSpec.model_fields)
        return {
            name: {k: v for k, v in spec.items() if k in known} if isinstance(spec, dict) else spec
            for name, spec in value.items()
        }

    @property
    def is_template(self) -> bool:
        """A shipped catalogue entry: copied into a scope, never injected itself."""
        return self.scope == SCOPE_SYSTEM

    def var_names(self) -> list[str]:
        """Every variable this credential is made of, in manifest order."""
        return list(self.vars or {})

    def required_var_names(self) -> list[str]:
        """The variables that must have a value for the credential to be connected."""
        return [name for name, spec in (self.vars or {}).items() if spec.required]
