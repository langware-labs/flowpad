"""SecretPack — a named set of environment variables, and the only way to
declare secrets.

Where the folder lives is the declaration's scope, using the asset scopes
Flowpad already has:

* ``<project>/agentic-assets/secret_pack/<name>/`` — declared for that project.
* ``~/agentic-assets/secret_pack/<name>/`` — declared for the user (every project
  on this machine).
* the shipped assistant project — ``system`` scope, a read-only TEMPLATE that
  declares nothing until it is added to one of the two scopes above.

Where the values live is ``value_store``: the scope's ``.env.local`` or the
encrypted vault (``credential_contract``), per environment — ``environments``
overrides the store or the required set for a named one. The manifest is
value-free, structurally: every parse runs through ``assert_value_free``.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Any, ClassVar, Optional

from pydantic import field_validator

from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.core import Entity
from flow_sdk.core.named_lookup import NameAmbiguous, NameNotFound
from flow_sdk.schema.data_spec.credential_contract import (
    DEFAULT_ENVIRONMENT,
    SCOPE_PROJECT,
    SCOPE_SYSTEM,
    SCOPE_USER,
    VALUE_STORE_ENV,
    normalize_environment,
)
from flow_sdk.schema.data_spec.credential_spec import (
    CURRENT_SCHEMA,
    CredentialEnvironmentSpec,
    CredentialVarSpec,
)
from flow_sdk.schema.types import EntityType
from flow_sdk.secrets.requirements import SecretRequirements

if TYPE_CHECKING:
    from flow_sdk.builtin.project import Project
    from flow_sdk.secrets import SecretStore


class CredentialNotFound(NameNotFound):
    """Neither the project nor the user scope declares a credential of that name."""

    message = "no credential named {name!r} in this project or the user scope"


class CredentialAmbiguous(NameAmbiguous):
    """More than one credential of that name in the scope that answered; ``candidates`` are typeids."""

    plural = "credentials"


class SecretPack(Entity):
    """The ROW; its shape on disk is ``CredentialSpec`` (``TypeInfo.asset_spec``)."""

    type: str = APIField(default=EntityType.SECRET_PACK.value)

    # A folder-backed asset, so it OWNS its path. PRIVATE: the path is this
    # machine's and means nothing to a receiver.
    asset_ref: Optional[str] = APIField(None, sharing=Sharing.PRIVATE)

    title: str = APIField(default="")
    description: str = APIField(default="")
    icon_name: str = APIField(default="")
    manifest_schema: int = APIField(default=CURRENT_SCHEMA)
    help_url: str = APIField(default="")
    setup_wiki: str = APIField(default="")
    #: How an agent obtains and stores the values (``CredentialSpec.setup``).
    setup: str = APIField(default="")
    value_store: str = APIField(default=VALUE_STORE_ENV)
    lm_provider: str = APIField(default="")
    vars: dict[str, CredentialVarSpec] = APIField(default_factory=dict)
    environments: dict[str, CredentialEnvironmentSpec] = APIField(default_factory=dict)

    _api_visible: ClassVar[bool] = True

    @field_validator("vars", "environments", mode="before")
    @classmethod
    def _project_nested(cls, value: Any, info: Any) -> Any:
        """Read each nested entry field by field, dropping keys the model does not name.

        A row indexed by an earlier build can carry fields that no longer exist
        (``sod_name``). The manifest is still strict — ``CredentialSpec``
        rejects them on disk — but a stored row must stay readable, or one stale
        row fails every credential query.
        """
        if not isinstance(value, dict):
            return value
        model = CredentialVarSpec if info.field_name == "vars" else CredentialEnvironmentSpec
        known = set(model.model_fields)
        return {
            name: {k: v for k, v in spec.items() if k in known} if isinstance(spec, dict) else spec
            for name, spec in value.items()
        }

    def store_for(self, environment: str = DEFAULT_ENVIRONMENT) -> str:
        """Where this credential's values live in ``environment``."""
        override = (self.environments or {}).get(environment)
        return (override and override.value_store) or self.value_store

    @property
    def is_template(self) -> bool:
        """A shipped catalogue entry: copied into a scope, never injected itself."""
        return self.scope == SCOPE_SYSTEM

    def var_names(self) -> list[str]:
        """Every variable this credential is made of, in manifest order."""
        return list(self.vars or {})

    def required_var_names(self, environment: str = DEFAULT_ENVIRONMENT) -> list[str]:
        """The variables that must have a value for the credential to be connected
        in ``environment`` — the environment's own list when it names one."""
        override = (self.environments or {}).get(environment)
        if override is not None and override.required is not None:
            return [name for name in self.vars or {} if name in set(override.required)]
        return [name for name, spec in (self.vars or {}).items() if spec.required]

    @property
    def credentials(self) -> SecretRequirements:
        """The names this credential needs a store to hold — the same accessor a data source has."""
        return SecretRequirements(self.var_names())

    async def secret_store(self, environment: str = DEFAULT_ENVIRONMENT) -> "SecretStore":
        """The store ``secret_pack.json`` names for ``environment``, configured for this row's scope."""
        from flow_sdk.builtin.credential_store import scope_of, secret_store_ref  # noqa: PLC0415
        from flow_sdk.secrets import SecretStore  # noqa: PLC0415

        scope, _ = await scope_of(self)
        if scope is None:
            raise LookupError(f"credential {self.name!r} is a template or its project is gone; it has no store")
        return SecretStore.from_ref(secret_store_ref(self, scope, normalize_environment(environment)))

    @classmethod
    async def get(cls, name: str, project: Optional["Project"] = None) -> "SecretPack":
        """The credential named ``name``: ``project``'s (default: the current project's), else the
        user scope's. Raises :class:`CredentialNotFound` or :class:`CredentialAmbiguous`."""
        from flow_sdk import context  # noqa: PLC0415
        from flow_sdk.builtin.credential_resolver import credentials_in_scope  # noqa: PLC0415

        if project is None:
            project = await context.current_project()
        named = [(spec, scope) for spec, scope in await credentials_in_scope(project) if spec.name == name]
        for wanted in (SCOPE_PROJECT, SCOPE_USER):
            matches = [spec for spec, scope in named if scope.scope == wanted]
            if len(matches) > 1:
                raise CredentialAmbiguous(name, [str(spec.typeid) for spec in matches])
            if matches:
                return matches[0]
        raise CredentialNotFound(name)
