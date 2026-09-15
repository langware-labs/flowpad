"""Secret stores: where named values live, keyed by environment variable name.

    store = await SecretStore.get()                       # the current project's .env.local
    await store.validate_keys(["DATABASE_URL"])           # MissingSecrets names what is absent
    values = await store.load(["DATABASE_URL"])           # {name: SecretStr}

See ``docs/snippets/secret-stores.md``.
"""
from flow_sdk.secrets.env_file import EnvFileConfig, EnvFileStore  # registers ``env_file``
from flow_sdk.secrets.errors import (
    MissingSecrets,
    NoCurrentProject,
    SecretStoreError,
    UnknownSecretStore,
    VaultNotEnabled,
)
from flow_sdk.secrets.requirements import SecretRequirements
from flow_sdk.secrets.store import SecretStore, SecretStoreRef, load_all, register_store
from flow_sdk.secrets.vault import VaultConfig, VaultStore  # registers ``vault``

__all__ = [
    "EnvFileConfig",
    "EnvFileStore",
    "MissingSecrets",
    "NoCurrentProject",
    "SecretRequirements",
    "SecretStore",
    "SecretStoreError",
    "SecretStoreRef",
    "UnknownSecretStore",
    "VaultConfig",
    "VaultNotEnabled",
    "VaultStore",
    "load_all",
    "register_store",
]
