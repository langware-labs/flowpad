"""``secret_pack.json`` — the on-disk shape of a ``SecretPack``.

A credential is a named set of environment variables (a "secret pack"). The
manifest declares them; it never carries a value. Where the values live is one
field, ``value_store``: the scope's ``.env.local`` (default) or the encrypted
vault. See ``credential_contract``.
"""
from __future__ import annotations

import re
from typing import Any, ClassVar

from pydantic import ConfigDict, Field, field_validator, model_validator

from flow_sdk.flowpad_types.enums.lm_provider_enums import LMApiProvider
from flow_sdk.schema.data_spec.credential_contract import (
    VALUE_STORE_ENV,
    VALUE_STORE_VAULT,
    VALUE_STORES,
    assert_value_free,
    is_valid_env_var,
    normalize_environment,
)
from flow_sdk.schema.data_spec.spec import DataSpec

CURRENT_SCHEMA = 2

LM_PROVIDERS = tuple(p.value for p in LMApiProvider if p is not LMApiProvider.FLOWPAD)

#: The name is the folder name, so it must be a path segment.
_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")

#: ``env_file`` is the SecretStore type's own name; a manifest keeps the ``env`` spelling.
_STORE_ALIASES = {"env_file": VALUE_STORE_ENV}


def _normalize_store(value: str) -> str:
    """The store's canonical name; raises for one this build does not know."""
    value = _STORE_ALIASES.get(value, value)
    if value not in VALUE_STORES:
        raise ValueError(f"unknown value_store {value!r}; expected one of {list(VALUE_STORES)}")
    return value


class CredentialVarSpec(DataSpec):
    """One environment variable a credential is made of.

    A near-copy of ``FieldHints`` (``data_driver.py``) without
    ``type``/``default``: an env var value is always a string, and a default for
    a secret would write a value nobody typed.
    """

    label: str = ""
    #: What this variable is for — shown under the input.
    hint: str = ""
    placeholder: str = ""
    required: bool = True
    #: Regex the value must match.
    pattern: str = ""
    advanced: bool = False
    #: Marks the variable that names the remote account (``GMAIL_ADDRESS``).
    account_key: bool = False
    #: Masks the input. Defaults TRUE — the safe direction to be wrong in.
    secret: bool = True
    #: Where to get this particular value.
    help_url: str = ""


class CredentialEnvironmentSpec(DataSpec):
    """How one environment differs from the credential's defaults.

    Keyed by environment name in ``CredentialSpec.environments``. The
    list of environments is never declared here — it is ``development`` plus
    every Deployment's ``environment``; an entry only overrides.
    """

    #: This environment's store; the credential's ``value_store`` when unset.
    value_store: str | None = None
    #: The variables that must have a value in this environment; each
    #: variable's own ``required`` when unset.
    required: list[str] | None = None

    @field_validator("value_store")
    @classmethod
    def _known_store(cls, value: str | None) -> str | None:
        value = str(value or "").strip()
        return _normalize_store(value) if value else None


class CredentialSpec(DataSpec):
    """``secret_pack.json`` — the shape, with every authoring rule as a validator."""

    main_file: ClassVar[str | None] = "secret_pack.json"

    model_config = ConfigDict(populate_by_name=True)  # extra="forbid" is DataSpec's

    #: The folder name.
    name: str
    title: str = ""
    description: str = ""
    #: A lucide glyph name. Not ``icon``: ``APIEntity.icon`` is a getter.
    icon_name: str = ""
    #: The file says ``schema``; the row says ``manifest_schema`` because the
    #: base Entity already owns ``schema_version``.
    manifest_schema: int = Field(default=0, alias="schema", validate_default=True)
    help_url: str = ""
    setup_wiki: str = ""
    #: Where this credential's values are read from and written to. Not
    #: ``store``: ``Entity.store`` is a method and a field would shadow it.
    value_store: str = VALUE_STORE_ENV
    #: The LLM provider this credential's single key funds. Forces the vault
    #: (the funding resolver reads ``lm_api.<provider>`` there).
    lm_provider: str = ""
    #: The variables, keyed by env var NAME.
    vars: dict[str, CredentialVarSpec] = Field(default_factory=dict)
    #: Per-environment overrides, keyed by environment name. Optional.
    environments: dict[str, CredentialEnvironmentSpec] = Field(default_factory=dict)

    @field_validator("environments")
    @classmethod
    def _named_environments(cls, value: dict[str, CredentialEnvironmentSpec]) -> dict[str, CredentialEnvironmentSpec]:
        return {normalize_environment(name): spec for name, spec in (value or {}).items()}

    @model_validator(mode="after")
    def _environment_rules(self) -> "CredentialSpec":
        if self.environments and self.lm_provider:
            raise ValueError("an lm_provider credential has no environments; deployments are hub-funded")
        for name, spec in self.environments.items():
            unknown = sorted(set(spec.required or []) - set(self.vars))
            if unknown:
                raise ValueError(f"environment {name!r} requires undeclared variables: {', '.join(unknown)}")
        return self

    @field_validator("name")
    @classmethod
    def _named(cls, value: str) -> str:
        value = str(value or "").strip()
        if not value:
            raise ValueError("manifest has no name")
        if not _NAME_RE.fullmatch(value):
            raise ValueError(f"{value!r} is not a valid credential name (letters, digits, '.', '_', '-')")
        return value

    @field_validator("manifest_schema")
    @classmethod
    def _current_schema(cls, value: int) -> int:
        if value != CURRENT_SCHEMA:
            raise ValueError(f"unsupported schema {value}; this build reads {CURRENT_SCHEMA}")
        return value

    @field_validator("lm_provider")
    @classmethod
    def _known_lm_provider(cls, value: str) -> str:
        value = str(value or "").strip()
        if value and value not in LM_PROVIDERS:
            raise ValueError(f"unknown lm_provider {value!r}; expected one of {sorted(LM_PROVIDERS)}")
        return value

    @field_validator("value_store")
    @classmethod
    def _known_store(cls, value: str) -> str:
        return _normalize_store(str(value or "").strip() or VALUE_STORE_ENV)

    @field_validator("vars")
    @classmethod
    def _usable_vars(cls, value: dict[str, CredentialVarSpec]) -> dict[str, CredentialVarSpec]:
        if not value:
            raise ValueError("a credential declares at least one variable")
        for name in value:
            if not is_valid_env_var(name):
                raise ValueError(f"{name!r} is not a valid environment variable name")
        return value

    @model_validator(mode="before")
    @classmethod
    def _title_defaults_to_name(cls, data: Any) -> Any:
        """A manifest that omits ``title`` is titled by its name."""
        if isinstance(data, dict) and not data.get("title"):
            name = str(data.get("name") or "").strip()
            if name:
                return {**data, "title": name}
        return data

    @model_validator(mode="before")
    @classmethod
    def _lm_provider_rules(cls, data: Any) -> Any:
        """An LLM provider credential is exactly one key, kept in the vault."""
        if not isinstance(data, dict):
            return data
        provider = str(data.get("lm_provider") or "").strip()
        if not provider:
            return data
        raw_vars = data.get("vars")
        if isinstance(raw_vars, dict) and len(raw_vars) != 1:
            raise ValueError(f"an lm_provider credential is one key; {provider!r} declares {len(raw_vars)} variables")
        store = str(data.get("value_store") or "").strip()
        if store and store != VALUE_STORE_VAULT:
            raise ValueError(f"an lm_provider credential is stored in the vault, not {store!r}")
        return {**data, "value_store": VALUE_STORE_VAULT}

    @model_validator(mode="before")
    @classmethod
    def _value_free(cls, data: Any) -> Any:
        """A definition names variables; it never carries one's value."""
        if isinstance(data, dict):
            assert_value_free(data, where="credential manifest")
        return data
