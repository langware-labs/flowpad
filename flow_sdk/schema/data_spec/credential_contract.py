"""The value-store contract a credential declaration and its readers share.

A ``CredentialSpec`` names environment variables; it never carries a value.
Values live in exactly one of two stores, chosen by the spec:

* ``env``   — the ``.env.local`` file at the scope's root (the project mount, or
  the user's home for a user-scope credential). The default.
* ``vault`` — the per-instance encrypted store (``flow_sdk/cli/auth/secrets.py``),
  the same thing as the file, encrypted at rest.

Everything here is a plain constant or a pure function so the manifest, the
store and the resolver agree on one spelling of each rule.
"""
from __future__ import annotations

import re
from typing import Any

ENV_VAR_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

VALUE_STORE_ENV = "env"
VALUE_STORE_VAULT = "vault"
VALUE_STORES = (VALUE_STORE_ENV, VALUE_STORE_VAULT)

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


def is_valid_env_var(name: str) -> bool:
    return bool(ENV_VAR_RE.fullmatch(name or ""))


def vault_name(*, scope: str, project_id: str | None, env_var: str, lm_provider: str = "") -> str:
    """The encrypted-store entry a credential variable's value lives under.

    Scoped like the env file it replaces: a project's value never answers for
    another project, so deleting one credential can never empty another's.
    """
    if lm_provider:
        return f"{LM_SECRET_PREFIX}{lm_provider}"
    if scope == SCOPE_PROJECT:
        if not project_id:
            raise ValueError("a project-scope vault value needs a project id")
        return f"{VAULT_PREFIX}project.{project_id}.{env_var}"
    if scope == SCOPE_USER:
        return f"{VAULT_PREFIX}user.{env_var}"
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
