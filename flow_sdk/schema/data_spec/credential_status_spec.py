"""What the Connections screen needs to know about declared credentials.

Names and presence only — no value ever appears in these shapes.
"""
from __future__ import annotations

from typing import Optional

from pydantic import ConfigDict

from flow_sdk.schema.data_spec.asset_setup_spec import SetupSkipSpec
from flow_sdk.schema.data_spec.credential_contract import (
    DEFAULT_ENVIRONMENT,
    CredentialRequirement,
    CredentialVarKind,
    Requirement,
)
from flow_sdk.schema.data_spec.spec import DataSpec


class CredentialVarStatusSpec(DataSpec):
    model_config = ConfigDict(frozen=True)

    env_var: str
    label: str = ""
    hint: str = ""
    placeholder: str = ""
    pattern: str = ""
    help_url: str = ""
    secret: bool = True
    #: What THIS deployment needs: the var's own ``required``, raised to ``MUST`` when the
    #: deployment requires it beyond the credential (``DeploymentSecretsSpec.require``).
    required: Requirement = CredentialRequirement.MUST
    kind: CredentialVarKind = CredentialVarKind.TEXT
    #: The store this deployment keeps the variable in: ``env`` / ``vault`` / a remote store type.
    store: str = "env"
    #: A value exists in that store.
    present: bool = False
    #: Where a value was found at all: ``env`` / ``vault`` / the remote store type / None.
    found_in: Optional[str] = None
    #: ``missing`` (no value anywhere), ``wrong-store`` (a value in the other local store) or
    #: ``unreachable`` (a remote store that could not be asked).
    warning: Optional[str] = None
    #: The typeid of the project credential overriding this user one, if any.
    shadowed_by: Optional[str] = None

    @property
    def is_must(self) -> bool:
        return self.required is CredentialRequirement.MUST


class CredentialStatusRowSpec(DataSpec):
    model_config = ConfigDict(frozen=True)

    typeid: str
    name: str
    title: str = ""
    description: str = ""
    icon_name: str = ""
    help_url: str = ""
    setup_wiki: str = ""
    #: How an agent obtains and stores the values (``CredentialSpec.setup``); empty = no AI Assist.
    setup: str = ""
    #: How long an agent following ``setup`` gets; ``None`` = the default.
    setup_timeout_seconds: Optional[float] = None
    scope: str
    project_id: Optional[str] = None
    #: The environment of the deployment these presences were read for.
    environment: str = DEFAULT_ENVIRONMENT
    #: Where that deployment keeps this credential: ``env`` / ``vault`` / a remote store type, or
    #: ``mixed`` when its variables are split (each var row says its own).
    value_store: str
    lm_provider: str = ""
    #: ``env`` (values are variables) or ``oauth`` (a provider's grant).
    kind: str = "env"
    #: oauth: the provider, the scopes the project needs, and those the held grant does not cover.
    provider: str = ""
    scopes: list[str] = []
    missing_scopes: list[str] = []
    #: Skipped in the project's setup on this machine (the record's ``setup_skipped``).
    setup_skipped: Optional[SetupSkipSpec] = None
    #: Where its folder is on this machine — what "Skip → Always" would remove.
    asset_ref: str = ""
    #: ``connected`` (every required value present / the grant held and covering), ``partial`` (some values;
    #: a grant missing scopes), ``needs_reauth`` (oauth: the grant went stale) or ``missing``.
    state: str
    vars: list[CredentialVarStatusSpec] = []


class DetectedKeySpec(DataSpec):
    model_config = ConfigDict(frozen=True)

    key: str
    line: int


class EnvFallbackStatusSpec(DataSpec):
    """A file the scope's env store falls back to — a project's declared ``env_files`` entry.
    Read, never written, so it has no ``blocked``."""

    model_config = ConfigDict(frozen=True)

    path: str
    #: As the project manifest declares it (``backend/.env``).
    extra_path: str
    exists: bool = False
    detected: list[DetectedKeySpec] = []


class ScopeFileStatusSpec(DataSpec):
    model_config = ConfigDict(frozen=True)

    scope: str
    project_id: Optional[str] = None
    #: The environment this env file belongs to (``.env.local`` is ``development``).
    environment: str = DEFAULT_ENVIRONMENT
    path: Optional[str] = None
    exists: bool = False
    blocked: bool = False
    block_code: Optional[str] = None
    block_reason: Optional[str] = None
    detected: list[DetectedKeySpec] = []
    #: The files read after this one, in order (``development`` only).
    fallbacks: list[EnvFallbackStatusSpec] = []


class DeploymentChoiceSpec(DataSpec):
    """A deployment the Credentials screen can show values for."""

    model_config = ConfigDict(frozen=True)

    id: str
    name: str = ""
    environment: str = DEFAULT_ENVIRONMENT
    this_computer: bool = False


class CredentialsStatusSpec(DataSpec):
    model_config = ConfigDict(frozen=True)

    project_id: Optional[str] = None
    #: The deployment this status was read for, and its environment.
    deployment_id: str = ""
    environment: str = DEFAULT_ENVIRONMENT
    #: Every deployment there is: this computer first.
    deployments: list[DeploymentChoiceSpec] = []
    vault_enabled: bool = False
    credentials: list[CredentialStatusRowSpec] = []
    files: list[ScopeFileStatusSpec] = []


class StoreForgottenSpec(DataSpec):
    """What deleting a credential did in ONE store. Names only."""

    model_config = ConfigDict(frozen=True)

    #: The store type: ``env_file`` / ``vault`` / ``gcp_secret_manager`` / ...
    type: str
    #: Where it is: a file path, a vault prefix, a secret project.
    where: str
    deleted: list[str] = []
    #: Still there: the store refused or failed to remove them.
    kept: list[str] = []
    #: Why the store could not be checked at all; every name counts as kept.
    error: str = ""


class CredentialDeletedSpec(DataSpec):
    """The result of deleting a credential: removed only when no store still holds a value."""

    model_config = ConfigDict(frozen=True)

    removed: bool
    deleted: list[str] = []
    kept: list[str] = []
    stores: list[StoreForgottenSpec] = []


class LeftoverSpec(DataSpec):
    """A secret still stored somewhere it should not be. The name, never the value."""

    model_config = ConfigDict(frozen=True)

    store: str
    where: str
    name: str


class UncheckedSpec(DataSpec):
    """A store the sweep could not read: unchecked is not clean."""

    model_config = ConfigDict(frozen=True)

    store: str
    where: str
    error: str


class SweepSpec(DataSpec):
    """``flow credentials audit``: what is left of deleted credentials, projects, agents and deployments."""

    model_config = ConfigDict(frozen=True)

    clean: bool
    found: list[LeftoverSpec] = []
    unchecked: list[UncheckedSpec] = []
    checked: list[str] = []
