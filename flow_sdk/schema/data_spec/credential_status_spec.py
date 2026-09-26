"""What the Connections screen needs to know about declared credentials.

Names and presence only — no value ever appears in these shapes.
"""
from __future__ import annotations

from typing import Optional

from pydantic import ConfigDict

from flow_sdk.schema.data_spec.credential_contract import DEFAULT_ENVIRONMENT
from flow_sdk.schema.data_spec.credential_spec import CredentialEnvironmentSpec
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
    required: bool = True
    #: A value exists in this credential's own store.
    present: bool = False
    #: Where a value was found at all: ``env`` / ``vault`` / None.
    found_in: Optional[str] = None
    #: ``missing`` (no value anywhere) or ``wrong-store`` (a value in the other store).
    warning: Optional[str] = None
    #: The typeid of the project credential overriding this user one, if any.
    shadowed_by: Optional[str] = None


class CredentialStatusRowSpec(DataSpec):
    model_config = ConfigDict(frozen=True)

    typeid: str
    name: str
    title: str = ""
    description: str = ""
    icon_name: str = ""
    help_url: str = ""
    setup_wiki: str = ""
    #: How an agent obtains and stores the values (``CredentialSpec.setup``); empty = no AI setup.
    setup: str = ""
    scope: str
    project_id: Optional[str] = None
    #: The environment these presences were read for.
    environment: str = DEFAULT_ENVIRONMENT
    #: This credential's store in that environment.
    value_store: str
    #: The manifest's own ``value_store`` and per-environment overrides — what an
    #: edit form must send back so saving never drops another environment's settings.
    default_value_store: str = "env"
    environments: dict[str, CredentialEnvironmentSpec] = {}
    lm_provider: str = ""
    #: ``connected`` (every required value present), ``partial`` or ``missing``.
    state: str
    vars: list[CredentialVarStatusSpec] = []


class DetectedKeySpec(DataSpec):
    model_config = ConfigDict(frozen=True)

    key: str
    line: int


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


class CredentialsStatusSpec(DataSpec):
    model_config = ConfigDict(frozen=True)

    project_id: Optional[str] = None
    #: The environment this status was read for.
    environment: str = DEFAULT_ENVIRONMENT
    #: Every environment there is: ``development`` plus each Deployment's.
    environments: list[str] = [DEFAULT_ENVIRONMENT]
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
