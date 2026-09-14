"""What the Connections screen needs to know about declared credentials.

Names and presence only — no value ever appears in these shapes.
"""
from __future__ import annotations

from typing import Optional

from pydantic import ConfigDict

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
    scope: str
    project_id: Optional[str] = None
    value_store: str
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
    path: Optional[str] = None
    exists: bool = False
    blocked: bool = False
    block_code: Optional[str] = None
    block_reason: Optional[str] = None
    detected: list[DetectedKeySpec] = []


class CredentialsStatusSpec(DataSpec):
    model_config = ConfigDict(frozen=True)

    project_id: Optional[str] = None
    vault_enabled: bool = False
    credentials: list[CredentialStatusRowSpec] = []
    files: list[ScopeFileStatusSpec] = []
