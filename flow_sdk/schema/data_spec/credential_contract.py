"""The value-store contract a credential declaration and its readers share.

A ``Credential`` names environment variables; it never carries a value, and
never says where its values live — a Deployment does (``DeploymentSecretsSpec``).
The two local stores, spelled here:

* ``env``   — the ``.env.local`` file at the scope's root (the project mount, or
  the user's home for a user-scope credential). The default.
* ``vault`` — the per-instance encrypted store (``flow_sdk/cli/auth/secrets.py``),
  the same thing as the file, encrypted at rest.

Values are kept per ENVIRONMENT (the deployment's). An environment is a Deployment's
``environment``; ``development`` is this computer and always exists. The
``development`` locations are the originals, unchanged: ``.env.local`` and
``credential.project.<pid>.VAR``. Any other environment gets its own file
(``.env.<env>.local``) and its own vault names.

Everything here is a plain constant or a pure function so the manifest, the
store and the resolver agree on one spelling of each rule.
"""
from __future__ import annotations

import re
from typing import Annotated, Any

from pydantic import BeforeValidator

from flow_sdk._compat import StrEnum

ENV_VAR_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

#: This computer's environment — the default, and the one every existing value is in.
DEFAULT_ENVIRONMENT = "development"
#: An environment name becomes part of a file name and a vault name, so it is a slug.
ENVIRONMENT_RE = re.compile(r"^[a-z][a-z0-9_-]{0,39}$")
#: Would make a named environment's vault name read as a scope.
RESERVED_ENVIRONMENTS = frozenset({"project", "user"})

ENV_LOCAL_FILENAME = ".env.local"

VALUE_STORE_ENV = "env"
VALUE_STORE_VAULT = "vault"

#: The two scopes a credential is authored in — the asset scopes Flowpad already
#: has. ``system`` (the shipped catalogue) is a template, never a declaration.
SCOPE_USER = "user"
SCOPE_PROJECT = "project"
SCOPE_SYSTEM = "system"
CREDENTIAL_SCOPES = (SCOPE_USER, SCOPE_PROJECT)

#: An LLM provider key is stored under this prefix, instance-wide — the funding
#: resolver (``llm_source._key_sources``) tests for ``lm_api.<provider>``.
LM_SECRET_PREFIX = "lm_api."

#: Every other vault value a credential owns is stored under this prefix, so it
#: can never collide with the hub login, cookie gate or MCP token entries that
#: share the encrypted file.
VAULT_PREFIX = "credential."

_FORBIDDEN_VALUE_KEYS = {"value", "secret_value", "plaintext", "plain_value"}


class CredentialRequirement(StrEnum):
    """How much a project needs one variable — a credential var's ``required``.

    ``MUST``: the app does not work without it. ``OPTIONAL``: it turns a feature,
    an integration or a deployment on. Compare against a member, never truthiness —
    ``"OPTIONAL"`` is a non-empty string.
    """

    MUST = "MUST"
    OPTIONAL = "OPTIONAL"


def as_requirement(value: Any) -> Any:
    """``required`` as written anywhere, as a ``CredentialRequirement``.

    Manifests, stored rows and API bodies written before the enum carry a bool
    (``true`` → ``MUST``, ``false`` → ``OPTIONAL``); the member name is accepted in
    any case. Anything else is returned as-is for the field to reject.
    """
    if isinstance(value, bool):
        return CredentialRequirement.MUST if value else CredentialRequirement.OPTIONAL
    if isinstance(value, str) and value.strip().upper() in CredentialRequirement.__members__:
        return CredentialRequirement(value.strip().upper())
    return value


class CredentialVarKind(StrEnum):
    """What a credential variable's value IS.

    ``text``: the value itself (an API key, a URL). ``file``: a file's content (a
    service-account key JSON) — kept as a file on this machine, and the variable
    holds that file's path, which is what tools like ``GOOGLE_APPLICATION_CREDENTIALS``
    expect.
    """

    TEXT = "text"
    FILE = "file"


#: A var's ``required`` field: the enum, reading a pre-enum bool on the way in.
Requirement = Annotated[CredentialRequirement, BeforeValidator(as_requirement)]


def is_valid_env_var(name: str) -> bool:
    return bool(ENV_VAR_RE.fullmatch(name or ""))


def is_valid_environment(name: str) -> bool:
    return bool(ENVIRONMENT_RE.fullmatch(name or "")) and name not in RESERVED_ENVIRONMENTS


def normalize_environment(name: str | None) -> str:
    """``name`` as an environment, ``development`` when empty. Raises on an invalid name."""
    value = str(name or "").strip() or DEFAULT_ENVIRONMENT
    if not is_valid_environment(value):
        raise ValueError(
            f"{value!r} is not a valid environment name (lowercase letters, digits, '-', '_'; "
            f"not {sorted(RESERVED_ENVIRONMENTS)})"
        )
    return value


def env_file_name(environment: str = DEFAULT_ENVIRONMENT) -> str:
    """The env file an environment's values live in: ``.env.local`` for ``development``,
    ``.env.<env>.local`` otherwise — the file a future "fetch secrets" step writes."""
    environment = normalize_environment(environment)
    return ENV_LOCAL_FILENAME if environment == DEFAULT_ENVIRONMENT else f".env.{environment}.local"


def vault_name(
    *,
    scope: str,
    project_id: str | None,
    env_var: str,
    lm_provider: str = "",
    environment: str = DEFAULT_ENVIRONMENT,
) -> str:
    """The encrypted-store entry a credential variable's value lives under.

    Scoped like the env file it replaces: a project's value never answers for
    another project, so deleting one credential can never empty another's. A
    named environment is a prefix, so ``development`` keeps its original names.
    """
    environment = normalize_environment(environment)
    if lm_provider:
        if environment != DEFAULT_ENVIRONMENT:
            raise ValueError("an LLM provider key has no per-environment value; deployments are hub-funded")
        return f"{LM_SECRET_PREFIX}{lm_provider}"
    prefix = VAULT_PREFIX if environment == DEFAULT_ENVIRONMENT else f"{VAULT_PREFIX}{environment}."
    if scope == SCOPE_PROJECT:
        if not project_id:
            raise ValueError("a project-scope vault value needs a project id")
        return f"{prefix}project.{project_id}.{env_var}"
    if scope == SCOPE_USER:
        return f"{prefix}user.{env_var}"
    raise ValueError(f"no vault location for scope {scope!r}")


def assert_value_free(data: Any, *, where: str = "credential manifest") -> None:
    """Raise if ``data`` carries a value-looking key at any depth."""
    if isinstance(data, dict):
        for k, v in data.items():
            if isinstance(k, str) and k.strip().lower() in _FORBIDDEN_VALUE_KEYS:
                raise ValueError(f"{where} must be value-free; found forbidden key {k!r}")
            assert_value_free(v, where=where)
    elif isinstance(data, (list, tuple)):
        for item in data:
            assert_value_free(item, where=where)
