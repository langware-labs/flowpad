"""Credential — a named set of environment variables, and the only way to
declare secrets.

Where the folder lives is the declaration's scope, using the asset scopes
Flowpad already has:

* ``<project>/agentic-assets/credential/<name>/`` — declared for that project.
* ``~/agentic-assets/credential/<name>/`` — declared for the user (every project
  on this machine).
* the shipped assistant project — ``system`` scope, a read-only TEMPLATE that
  declares nothing until it is added to one of the two scopes above.

Where the values live is never the credential's: each Deployment says it
(``DeploymentSecretsSpec``; ``credential_store.Placement``). The manifest is
value-free, structurally: every parse runs through ``assert_value_free``.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Any, ClassVar, Optional

from pydantic import field_validator

from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.core import Entity
from flow_sdk.core.named_lookup import NameAmbiguous, NameNotFound
from flow_sdk.schema.data_spec.credential_contract import SCOPE_PROJECT, SCOPE_SYSTEM, SCOPE_USER
from flow_sdk.schema.data_spec.credential_spec import CURRENT_SCHEMA, CredentialVarSpec
from flow_sdk.schema.types import EntityType
from flow_sdk.secrets.requirements import SecretRequirements

if TYPE_CHECKING:
    from flow_sdk.builtin.deployment import Deployment
    from flow_sdk.builtin.project import Project
    from flow_sdk.secrets import SecretStore


class CredentialNotFound(NameNotFound):
    """Neither the project nor the user scope declares a credential of that name."""

    message = "no credential named {name!r} in this project or the user scope"


class CredentialAmbiguous(NameAmbiguous):
    """More than one credential of that name in the scope that answered; ``candidates`` are typeids."""

    plural = "credentials"


class Credential(Entity):
    """The ROW; its shape on disk is ``CredentialSpec`` (``TypeInfo.asset_spec``)."""

    type: str = APIField(default=EntityType.CREDENTIAL.value)

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
    lm_provider: str = APIField(default="")
    vars: dict[str, CredentialVarSpec] = APIField(default_factory=dict)

    _api_visible: ClassVar[bool] = True

    @field_validator("vars", mode="before")
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
        """The variables that must have a value for the credential to be connected
        (a deployment may require more: ``Placement.required``)."""
        return [name for name, spec in (self.vars or {}).items() if spec.required]

    @property
    def credentials(self) -> SecretRequirements:
        """The names this credential needs a store to hold — the same accessor a data source has."""
        return SecretRequirements(self.var_names())

    async def secret_store(self, deployment: Optional["Deployment"] = None) -> "SecretStore":
        """The store ``deployment`` (default: this computer) keeps this credential's values in,
        configured for this row's scope. Raises ``LookupError`` when its variables are split
        across stores there — ask per variable (``credential_store.secret_store_ref``)."""
        from flow_sdk.builtin.credential_store import Placement, scope_of, secret_store_ref  # noqa: PLC0415
        from flow_sdk.secrets import SecretStore  # noqa: PLC0415

        scope, _ = await scope_of(self)
        if scope is None:
            raise LookupError(f"credential {self.name!r} is a template or its project is gone; it has no store")
        placement = await Placement.of(deployment)
        refs = {ref.key: ref for ref in (secret_store_ref(self, scope, name, placement) for name in self.var_names())}
        if len(refs) != 1:
            raise LookupError(f"credential {self.name!r} keeps its variables in {len(refs)} stores here; ask per variable")
        return SecretStore.from_ref(next(iter(refs.values())))

    @classmethod
    async def get(cls, name: str, project: Optional["Project"] = None) -> "Credential":
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
