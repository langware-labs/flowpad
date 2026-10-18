"""``credential.json`` — the on-disk shape of a ``Credential``.

A credential declares WHAT is needed, never a value:

* ``kind: env`` (the default) — a named set of environment variables. Where their values live is each
  Deployment's (``DeploymentSecretsSpec``).
* ``kind: oauth`` — a grant from ``provider`` covering ``scopes``, given by a person in a browser. The
  token lives with the connection (this instance's encrypted store, or the hub), never in a variable.

See ``credential_contract``.
"""
from __future__ import annotations

import re
from typing import Any, ClassVar, Optional

from pydantic import ConfigDict, Field, field_validator, model_validator

from flow_sdk.flowpad_types.enums.lm_provider_enums import LMApiProvider
from flow_sdk.schema.data_spec.compute_op_spec import CliOp
from flow_sdk.schema.data_spec.credential_status_spec import CredentialWaySpec, ways
from flow_sdk.schema.data_spec.credential_contract import (
    CredentialKind,
    CredentialRequirement,
    CredentialVarKind,
    Requirement,
    assert_value_free,
    is_valid_env_var,
)
from flow_sdk.schema.data_spec.io.native import Text
from flow_sdk.schema.data_spec.setup_stage_spec import SetupStageSpec, unique_stages
from flow_sdk.schema.data_spec.spec import DataSpec

CURRENT_SCHEMA = 2

LM_PROVIDERS = tuple(p.value for p in LMApiProvider if p is not LMApiProvider.FLOWPAD)

#: The name is the folder name, so it must be a path segment.
_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")

#: Where-keys a manifest carried before deployments held them (0.2.178). Dropped on read; the boot
#: lift (``migration_2026_09_credential_stores``) moves them onto deployments and off the file.
LEGACY_STORE_KEYS = ("value_store", "environments")


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
    #: ``MUST`` (the app does not work without it), ``OPTIONAL``, or ``ONE_OF`` (any one of the
    #: credential's ``ONE_OF`` variables is enough). Defaults MUST — an unmarked variable stays
    #: required, the safe direction to be wrong in.
    required: Requirement = CredentialRequirement.MUST
    #: Regex the value must match.
    pattern: str = ""
    advanced: bool = False
    #: Marks the variable that names the remote account (``GMAIL_ADDRESS``).
    account_key: bool = False
    #: Masks the input. Defaults TRUE — the safe direction to be wrong in.
    secret: bool = True
    #: ``text`` (the value), ``file`` (a file's content, kept as a file; the variable holds its path),
    #: ``cli`` (a sign-in a command-line tool holds: no value, ``login`` and ``check`` instead) or
    #: ``oauth`` (a grant from ``provider`` covering ``scopes``: no value, the connection holds it).
    kind: CredentialVarKind = CredentialVarKind.TEXT
    #: cli: the command a person runs to sign in, per OS.
    login: Optional[CliOp] = None
    #: cli: the command that exits 0 when the sign-in is there, per OS.
    check: Optional[CliOp] = None
    #: oauth: the connection provider the grant is from, and the scopes it must cover.
    provider: str = ""
    scopes: list[str] = Field(default_factory=list)
    #: Where to get this particular value.
    help_url: str = ""
    #: ONE_OF: the way this variable belongs to. ONE_OF variables sharing a ``way`` are given together
    #: (an address and its app password); empty — the variable is a way of its own, named after itself.
    way: str = ""

    @property
    def is_must(self) -> bool:
        return self.required is CredentialRequirement.MUST

    @property
    def is_one_of(self) -> bool:
        return self.required is CredentialRequirement.ONE_OF

    @property
    def is_cli(self) -> bool:
        return self.kind is CredentialVarKind.CLI

    @property
    def is_oauth(self) -> bool:
        return self.kind is CredentialVarKind.OAUTH

    @property
    def holds_value(self) -> bool:
        """A store keeps a value for it — not a sign-in (``cli``) or a grant (``oauth``), which live elsewhere."""
        return not (self.is_cli or self.is_oauth)

    @property
    def login_command(self) -> str:
        """cli: the sign-in command for this machine's OS; empty when there is none."""
        return (self.login.command_for() or "") if self.login is not None else ""

    @model_validator(mode="after")
    def _cli_rules(self) -> "CredentialVarSpec":
        if self.is_cli and (self.login is None or self.check is None):
            raise ValueError("a cli variable declares its login and its check")
        if not self.is_cli and (self.login is not None or self.check is not None):
            raise ValueError("login and check belong to a cli variable (kind: cli)")
        if self.is_oauth and not self.provider:
            raise ValueError("an oauth variable names its provider")
        if not self.is_oauth and (self.provider or self.scopes):
            raise ValueError("provider and scopes belong to an oauth variable (kind: oauth)")
        if self.is_oauth and not self.is_one_of:
            raise ValueError("an oauth variable is one way of a ONE_OF group (required: ONE_OF)")
        if self.way and not self.is_one_of:
            raise ValueError("a way belongs to a ONE_OF variable (required: ONE_OF)")
        return self

    @field_validator("provider")
    @classmethod
    def _provider_name(cls, value: str) -> str:
        return str(value or "").strip().lower()


class CredentialSpec(DataSpec):
    """``credential.json`` — the shape, with every authoring rule as a validator."""

    main_file: ClassVar[str | None] = "credential.json"

    model_config = ConfigDict(populate_by_name=True)  # extra="forbid" is DataSpec's

    #: The folder name.
    name: str
    title: str = ""
    description: str = ""
    #: One line: what the project uses this credential FOR — shown beside its name when a person is asked
    #: for it. ``description`` says what the credential is; this says why it is wanted here.
    needed_for: str = ""
    #: The full reason, when one line is not enough — shown behind the info icon next to ``needed_for``.
    justification: str = ""
    #: A lucide glyph name. Not ``icon``: ``APIEntity.icon`` is a getter.
    icon_name: str = ""
    #: The file says ``schema``; the row says ``manifest_schema`` because the
    #: base Entity already owns ``schema_version``.
    manifest_schema: int = Field(default=0, alias="schema", validate_default=True)
    help_url: str = ""
    setup_wiki: str = ""
    #: How to obtain the values and store them — the file ``setup.md`` beside ``credential.json``,
    #: markdown a person follows by hand (the setup dialog and the credential page show it) and an agent
    #: follows too: where each value is created, what to click, and the
    #: ``flow credentials set <name> --stdin`` it is piped into. Authoring requires it
    #: (``credential_service.save_credential``); a pack read from disk without it still loads —
    #: ``flow project setup`` reports it, and offers no AI Assist for it.
    setup: Text = ""
    #: How long following ``setup`` may take once an agent runs it (the ask's AI Assist): the question
    #: waits this long from the moment the agent starts, and the agent is stopped at it. Unset: the
    #: default ``SETUP_TIMEOUT`` (``compute_op_spec``). A slow console (a key that takes minutes to
    #: issue) declares its own.
    setup_timeout_seconds: Optional[float] = Field(default=None, gt=0)
    #: The LLM provider this credential's single key funds. Its value always lives in the vault
    #: entry the funding resolver reads (``lm_api.<provider>``), whatever a deployment says.
    lm_provider: str = ""
    #: ``env``: values are variables. ``oauth``: the value is a grant (``provider``, ``scopes``).
    kind: CredentialKind = CredentialKind.ENV
    #: oauth: the connection provider the grant is from (the OAuth registry's or the hub's name).
    provider: str = ""
    #: oauth: the scopes the grant must cover — the union of what the project's sources need.
    scopes: list[str] = Field(default_factory=list)
    #: oauth: scopes that turn an extra feature on; never needed for the credential to count as connected.
    optional_scopes: list[str] = Field(default_factory=list)
    #: The variables, keyed by env var NAME. Required for ``env``; an ``oauth`` credential needs none.
    vars: dict[str, CredentialVarSpec] = Field(default_factory=dict)
    #: ONE_OF: how each way of several variables is offered (its title and one line under it), by way name.
    #: A way of one variable is offered by that variable's own label and hint.
    ways: dict[str, CredentialWaySpec] = Field(default_factory=dict)
    #: The wizards this credential's values are obtained with, in order (``setup_stage_spec.py``).
    #: Empty: the default ask-store-check wizard ``flow project setup`` compiles from ``vars``.
    setup_wizards: list[SetupStageSpec] = Field(default_factory=list)

    @field_validator("setup_wizards")
    @classmethod
    def _stages_unique(cls, value: list[SetupStageSpec]) -> list[SetupStageSpec]:
        return unique_stages(value)

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

    @field_validator("vars")
    @classmethod
    def _usable_vars(cls, value: dict[str, CredentialVarSpec]) -> dict[str, CredentialVarSpec]:
        for name in value:
            if not is_valid_env_var(name):
                raise ValueError(f"{name!r} is not a valid environment variable name")
        return value

    @field_validator("provider")
    @classmethod
    def _provider_name(cls, value: str) -> str:
        return str(value or "").strip().lower()

    @model_validator(mode="after")
    def _kind_rules(self) -> "CredentialSpec":
        """An ``env`` credential IS its variables; an ``oauth`` one IS its provider's grant."""
        if self.kind is CredentialKind.OAUTH:
            if not self.provider:
                raise ValueError("an oauth credential names its provider")
            if self.lm_provider:
                raise ValueError("an oauth credential cannot fund an LLM provider (lm_provider is a key)")
        else:
            if not self.vars:
                raise ValueError("a credential declares at least one variable")
            if self.provider or self.scopes or self.optional_scopes:
                raise ValueError("provider and scopes belong to an oauth credential (kind: oauth)")
            grouped = ways(self.vars)
            for way, members in grouped.items():
                if len(members) > 1 and any(not self.vars[m].holds_value for m in members):
                    raise ValueError(f"way {way!r}: a sign-in (cli or oauth) variable is alone in its way")
            if len(grouped) == 1:
                raise ValueError("ONE_OF is a choice: a credential declares at least two ONE_OF ways, or none")
            if unknown := sorted(set(self.ways) - set(grouped)):
                raise ValueError(f"ways {unknown} name no ONE_OF way of this credential")
            if self.lm_provider and any(v.is_one_of or not v.holds_value for v in self.vars.values()):
                raise ValueError("an lm_provider credential is one stored key (no ONE_OF, no cli variable)")
        return self

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
        """An LLM provider credential is exactly one key."""
        if not isinstance(data, dict):
            return data
        provider = str(data.get("lm_provider") or "").strip()
        raw_vars = data.get("vars")
        if provider and isinstance(raw_vars, dict) and len(raw_vars) != 1:
            raise ValueError(f"an lm_provider credential is one key; {provider!r} declares {len(raw_vars)} variables")
        return data

    @model_validator(mode="before")
    @classmethod
    def _drop_legacy_store_keys(cls, data: Any) -> Any:
        """A manifest written before 0.2.178 still says where its values live; that is a deployment's
        now. The keys are dropped here and moved by the boot lift — never an error on read."""
        if isinstance(data, dict) and any(key in data for key in LEGACY_STORE_KEYS):
            return {k: v for k, v in data.items() if k not in LEGACY_STORE_KEYS}
        return data

    @model_validator(mode="before")
    @classmethod
    def _value_free(cls, data: Any) -> Any:
        """A definition names variables; it never carries one's value."""
        if isinstance(data, dict):
            assert_value_free(data, where="credential manifest")
        return data
