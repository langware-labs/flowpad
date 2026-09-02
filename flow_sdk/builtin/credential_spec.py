"""CredentialSpec — the authored definition of a named credential.

A credential is a NAMED SET OF ENVIRONMENT VARIABLES some provider needs: Gmail
is ``GMAIL_ADDRESS`` + ``GMAIL_APP_PASSWORD``; Twilio is an account SID and an
auth token. This is the definition of that set. It is not the values, and it is
not the per-project decision to require them.

The split mirrors ``DataSourceSpec`` : ``DataSource`` exactly, one layer over:

    CredentialSpec  :  SecretOrigin
          ==
    DataSourceSpec  :  DataSource

``SecretOrigin`` (``flow_sdk/builtin/secret_origin.py``) is the per-project
DECLARATION — identity ``(project_id, env_var)``, one row per VARIABLE, carrying
a locator that says where THIS machine keeps the value. ``CredentialSpec`` is
global, shipped, and says what the credential IS. One spec fans out to N
``SecretOrigin`` rows.

The invariant that keeps the two apart is load-bearing:

    CredentialSpec never names a store for a specific project or a project id.
    SecretOrigin never carries provider presentation.

Break it and the same Gmail credential can no longer sit in ``.env.local`` here
and in the hub vault on a teammate's machine — which is the entire reason the
locator exists.

**A manifest is value-free, structurally.** Every parse runs through
``assert_value_free``, so a bundled or agent-authored ``credential.json`` that
carries a ``value:`` fails to index rather than shipping a secret in git.
"""
from __future__ import annotations

from typing import Any, ClassVar, Optional

from pydantic import ConfigDict, Field, field_validator, model_validator

from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.builtin.secret_origin import (
    SOD_STORE_ENV_LOCAL,
    SOD_STORE_SODOT,
    assert_value_free,
    is_valid_secret_origin_env_var,
)
from flow_sdk.core import Entity
from flow_sdk.flowpad_types.enums.lm_provider_enums import LMApiProvider
from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.schema.types import EntityType

#: The manifest format this build reads. A manifest that says otherwise is a
#: load error, not a best-effort parse — same rule as ``ManifestSpec``.
CURRENT_SCHEMA = 1

#: Where a provided value is cached by default. The same two local stores
#: ``SecretOrigin.effective_sod_store`` chooses between; named from there rather
#: than re-spelled, so a third store cannot appear in one place only.
VALID_STORES = (SOD_STORE_ENV_LOCAL, SOD_STORE_SODOT)

#: The providers an ``lm_provider`` may name. ``FLOWPAD`` is excluded on purpose:
#: its "key" is the hub login the box already holds and the hub owns the binding,
#: so there is nothing for a person to type and nothing to store
#: (``cli/auth/lm_api_keys.set_lm_api`` raises for it).
LM_PROVIDERS = tuple(p.value for p in LMApiProvider if p is not LMApiProvider.FLOWPAD)


class CredentialManifestError(ValueError):
    """A credential folder that cannot be loaded. The message is shown to an author."""


class CredentialVarSpec(DataSpec):
    """One environment variable this credential is made of.

    Deliberately a near-copy of ``ConfigFieldSpec`` (``data_source_spec.py``),
    whose docstring names this exact job — "the whole reason the frontend can
    stop hardcoding a catalog per provider". Two fields of that shape are
    dropped and two are added, and each difference is a real one:

    * no ``type``/``coerce``: ``FieldType`` exists so a DataSource config value
      can be stored structured on a row. An env var value is always a string —
      ``write_env_local`` ends at ``set_key(path, key, value)`` — so a type here
      would promise a coercion no writer performs.
    * no ``default``: a default for a secret is dangerous, and a default for a
      non-secret would silently write a value nobody typed into the user's
      ``.env.local``.
    * ``secret``: the one genuinely new axis. ``ConfigFieldSpec`` has no secrecy
      concept because its values live on a row; these live in a value store.
    * ``help_url``: where you obtain THIS value differs within one credential —
      you know your Gmail address; the app password is behind a specific page.
    """

    label: str = ""
    hint: str = ""
    placeholder: str = ""
    required: bool = True
    #: Regex the value must match — replaces the per-provider validators.
    pattern: str = ""
    advanced: bool = False
    #: Marks the variable that names the remote account (``GMAIL_ADDRESS``).
    #: Descriptive only, exactly as on ``ConfigFieldSpec``: nothing dedupes on
    #: it, so a wrong one is a plain edit.
    account_key: bool = False
    #: Masks the input and keeps the value out of every echo path. Defaults
    #: TRUE so a member that forgets to declare is treated as a secret — the
    #: safe direction to be wrong in.
    secret: bool = True
    #: Where to get this particular value.
    help_url: str = ""
    #: The name this value is stored under in the encrypted ``sodot`` store —
    #: the ``sod_name`` a ``LocalSecretRef`` carries. DERIVED, not authored: it
    #: is filled from ``lm_provider`` (or from the variable's own name for a
    #: plain ``sodot`` credential) by ``_sodot_coordinates`` below, so the
    #: ``lm_api.`` prefix has exactly one spelling in the codebase and the
    #: frontend can build a locator without knowing the convention exists.
    sod_name: str = ""


class CredentialManifestSpec(DataSpec):
    """``credential.json`` — the shape, with every authoring rule as a validator."""

    model_config = ConfigDict(populate_by_name=True)  # extra="forbid" is DataSpec's

    #: The registry key AND the folder name. One noun, exactly as ``ManifestSpec.name``.
    name: str
    title: str = ""
    description: str = ""
    #: A lucide glyph name. Deliberately not ``icon``: ``APIEntity.icon`` is a
    #: getter returning the TYPE's registry glyph, and a field by that name
    #: shadows the getter and throws on hydration — which has already emptied a
    #: whole provider list once.
    icon_name: str = ""
    #: Manifest format version — the file says ``schema``; the row says
    #: ``manifest_schema`` because the base Entity already owns ``schema_version``.
    manifest_schema: int = Field(default=0, alias="schema", validate_default=True)
    #: EXTERNAL page where a person obtains this credential. Distinct from
    #: ``setup_wiki``, which is an internal wiki page id: two destinations, two
    #: renderers, so two fields.
    help_url: str = ""
    setup_wiki: str = ""
    #: Which local store a provided value defaults into. A DEFAULT, not a
    #: binding — the declaration owns the real choice, and the existing
    #: "Change origin" affordance already handles the per-variable exception.
    #:
    #: NOT named ``store``: ``Entity.store`` is a METHOD, and a field by that
    #: name shadows it on the row — the same trap ``icon_name`` exists to avoid
    #: one field up. The manifest key matches the row field so the serializer
    #: needs no mapping.
    default_store: str = SOD_STORE_ENV_LOCAL
    #: The LLM API provider this credential's key authenticates against, when it
    #: is one. Naming it is the whole declaration: the store, the ``sod_name``
    #: under which the key is written, and therefore whether the LLM funding
    #: resolver can see it all fall out of this one fact rather than being
    #: spelled three times by an author who could get one of them wrong.
    #:
    #: An LM credential is exactly ONE key, so a manifest that names a provider
    #: and declares two variables is a load error, not a guess about which one
    #: holds the key.
    lm_provider: str = ""
    #: The variables, keyed by env var NAME. The name is half of
    #: ``SecretOrigin.id_for(project_id, env_var)``, so keying on anything else
    #: would need a mapping table that can drift out of agreement with identity.
    vars: dict[str, CredentialVarSpec] = Field(default_factory=dict)

    @field_validator("lm_provider")
    @classmethod
    def _known_lm_provider(cls, value: str) -> str:
        value = str(value or "").strip()
        if value and value not in LM_PROVIDERS:
            raise ValueError(
                f"unknown lm_provider {value!r}; expected one of {sorted(LM_PROVIDERS)}"
            )
        return value

    @field_validator("name")
    @classmethod
    def _named(cls, value: str) -> str:
        value = str(value or "").strip()
        if not value:
            raise ValueError("manifest has no name")
        return value

    @field_validator("manifest_schema")
    @classmethod
    def _current_schema(cls, value: int) -> int:
        if value != CURRENT_SCHEMA:
            raise ValueError(f"unsupported schema {value}; this build reads {CURRENT_SCHEMA}")
        return value

    @field_validator("default_store")
    @classmethod
    def _known_store(cls, value: str) -> str:
        value = str(value or "").strip() or SOD_STORE_ENV_LOCAL
        if value not in VALID_STORES:
            raise ValueError(f"unknown store {value!r}; expected one of {sorted(VALID_STORES)}")
        return value

    @field_validator("vars")
    @classmethod
    def _usable_vars(cls, value: dict[str, CredentialVarSpec]) -> dict[str, CredentialVarSpec]:
        if not value:
            raise ValueError("a credential declares at least one variable")
        for name in value:
            # The key becomes an env var injected into a process and half of a
            # SecretOrigin id. A name that cannot be either is a load error, not
            # a row that fails later at spawn.
            if not is_valid_secret_origin_env_var(name):
                raise ValueError(f"{name!r} is not a valid environment variable name")
        return value

    @model_validator(mode="before")
    @classmethod
    def _title_defaults_to_name(cls, data: Any) -> Any:
        """A manifest that omits ``title`` is titled by its name.

        Filled BEFORE construction rather than assigned after: a ``DataSpec`` is
        frozen, so an after-validator cannot write to the instance it was handed.
        """
        if isinstance(data, dict) and not data.get("title"):
            name = str(data.get("name") or "").strip()
            if name:
                return {**data, "title": name}
        return data

    @model_validator(mode="before")
    @classmethod
    def _sodot_coordinates(cls, data: Any) -> Any:
        """Fill the ``sodot`` coordinates an author should never have to type.

        A credential that names an ``lm_provider`` is making one claim — "this is
        the key for that provider" — and the store and the secret's name follow
        from it. Deriving them here is what makes the whole feature work with no
        change to the LLM funding resolver: ``_key_sources``
        (``agentic_process/cli_drivers/llm_source.py``) decides a provider is
        funded by testing for a stored secret NAMED ``lm_api.<provider>``, so a
        declaration carrying that ``sod_name`` writes the key exactly where the
        resolver already looks.

        Filled BEFORE construction because ``DataSpec`` is frozen. Anything the
        author DID write wins — this only supplies what was left out.
        """
        from flow_sdk.builtin.llm_endpoint import LM_SECRET_PREFIX  # noqa: PLC0415

        if not isinstance(data, dict):
            return data
        raw_vars = data.get("vars")
        if not isinstance(raw_vars, dict):
            return data

        provider = str(data.get("lm_provider") or "").strip()
        if provider and len(raw_vars) != 1:
            raise ValueError(
                f"an lm_provider credential is one key; {provider!r} declares "
                f"{len(raw_vars)} variables"
            )
        store = str(data.get("default_store") or "").strip()
        if provider and not store:
            store = SOD_STORE_SODOT
        if store != SOD_STORE_SODOT:
            return data if not provider else {**data, "default_store": store}

        filled: dict[str, Any] = {}
        for env_var, spec in raw_vars.items():
            if not isinstance(spec, dict):
                filled[env_var] = spec  # already a CredentialVarSpec; nothing to fill
                continue
            if spec.get("sod_name"):
                filled[env_var] = spec
                continue
            # An LM key is addressed by its provider so the set stays enumerable;
            # any other sodot value is addressed by its own variable name.
            filled[env_var] = {
                **spec,
                "sod_name": f"{LM_SECRET_PREFIX}{provider}" if provider else env_var,
            }
        return {**data, "default_store": store, "vars": filled}

    @model_validator(mode="before")
    @classmethod
    def _value_free(cls, data: Any) -> Any:
        """A definition names variables; it never carries one's value.

        Cheap, and it is the guard that makes the whole family safe to ship in
        git and safe to let an agent author. ``extra="forbid"`` already rejects
        an unknown key at the top level, but a value nested inside a ``vars``
        entry would otherwise only be caught there — and this says WHY.
        """
        if isinstance(data, dict):
            assert_value_free(data, where="credential manifest")
        return data


class CredentialSpec(Entity):
    """The ROW; its shape on disk is ``CredentialManifestSpec`` (``TypeInfo.asset_spec``)."""

    type: str = APIField(default=EntityType.CREDENTIAL_SPEC.value)

    # A folder-backed asset, so it OWNS its path — declaring `asset_ref` is what
    # enrolls the class in `Entity.asset_owner_classes()`, and therefore what
    # lets `get_by_asset_ref` resolve a folder to this row. PRIVATE: the path is
    # this machine's and means nothing to a receiver.
    asset_ref: Optional[str] = APIField(None, sharing=Sharing.PRIVATE)

    # -- the header, held as entity fields --
    title: str = APIField(default="")
    description: str = APIField(default="")
    icon_name: str = APIField(default="")
    manifest_schema: int = APIField(default=CURRENT_SCHEMA)
    help_url: str = APIField(default="")
    setup_wiki: str = APIField(default="")
    default_store: str = APIField(default=SOD_STORE_ENV_LOCAL)
    lm_provider: str = APIField(default="")
    vars: dict[str, CredentialVarSpec] = APIField(default_factory=dict)

    _api_visible: ClassVar[bool] = True

    def var_names(self) -> list[str]:
        """Every variable this credential is made of, in manifest order."""
        return list(self.vars or {})

    def required_var_names(self) -> list[str]:
        """The variables that must be satisfied for the credential to be usable.

        The tri-state a connection row renders — connected / partial / not
        connected — is computed against THIS list, not ``var_names``: an
        optional member missing must not hold a working credential at "partial".
        """
        return [name for name, spec in (self.vars or {}).items() if spec.required]
