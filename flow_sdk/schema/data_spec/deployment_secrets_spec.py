"""Where a deployment keeps its credential values — the WHERE a credential never says.

A credential names variables (``CredentialSpec``); a deployment says where their values live. The
env var NAME is the key in every store. A local store type with no config is completed per credential
scope and the deployment's ``environment`` — the scope's ``.env.local`` (``.env.<env>.local``) or its
vault names ``credential.[<env>.]user.`` / ``credential.[<env>.]project.<pid>.`` — so the names a value
was stored under before deployments held this binding still resolve.
"""
from __future__ import annotations

from typing import ClassVar

from pydantic import ConfigDict, Field, field_validator

from flow_sdk.schema.data_spec.credential_contract import is_valid_env_var
from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.secrets.store import SecretStoreRef

#: A value kept in the scope's env file — the default store.
ENV_FILE = SecretStoreRef(type="env_file")
#: A value kept in this instance's encrypted vault.
VAULT = SecretStoreRef(type="vault")


class DeploymentSecretsSpec(DataSpec):
    """A deployment's store, its per-variable exceptions, and what it additionally requires."""

    model_config = ConfigDict(frozen=True)
    spec_kind: ClassVar[str] = "deployment.secrets"

    #: Where every variable's value lives unless ``exceptions`` names another store.
    store: SecretStoreRef = Field(default_factory=lambda: ENV_FILE)
    #: ``{VAR: store}`` for a variable kept somewhere else (the vault, a remote store).
    exceptions: dict[str, SecretStoreRef] = Field(default_factory=dict)
    #: Variables that must have a value HERE, beyond each credential's own required ones.
    require: list[str] = Field(default_factory=list)
    #: Values only in a remote store, never copied in from another deployment (enforced by sharing).
    protected: bool = False

    @field_validator("exceptions")
    @classmethod
    def _named(cls, value: dict[str, SecretStoreRef]) -> dict[str, SecretStoreRef]:
        bad = sorted(name for name in value if not is_valid_env_var(name))
        if bad:
            raise ValueError(f"not a variable name: {', '.join(bad)}")
        return value

    def store_of(self, env_var: str) -> SecretStoreRef:
        """The store ``env_var``'s value lives in (before scope completion)."""
        return self.exceptions.get(env_var) or self.store

    def with_store(self, env_vars: list[str], store: SecretStoreRef) -> "DeploymentSecretsSpec":
        """A copy keeping ``env_vars`` in ``store`` — an exception, or none when it is the default."""
        exceptions = {k: v for k, v in self.exceptions.items() if k not in env_vars}
        if store.key != self.store.key:
            exceptions.update({name: store for name in env_vars})
        return self.model_copy(update={"exceptions": exceptions})


__all__ = ["ENV_FILE", "VAULT", "DeploymentSecretsSpec"]
