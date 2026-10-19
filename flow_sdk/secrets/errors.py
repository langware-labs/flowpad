"""What a secret store raises. A message names variables, never a value."""
from __future__ import annotations

from typing import Iterable


class SecretStoreError(RuntimeError):
    """Base for every store failure; ``code`` lets a caller render the fix."""

    code = "secret-store"


class MissingSecrets(SecretStoreError, LookupError):
    """The store lacks names a consumer needs. ``missing`` is the list, in the order asked."""

    code = "missing-secrets"

    def __init__(self, missing: Iterable[str], store: str = "") -> None:
        self.missing = list(missing)
        where = f" in the {store} store" if store else ""
        super().__init__(f"missing {', '.join(self.missing)}{where}")


class NoCurrentProject(SecretStoreError, LookupError):
    """The default store was asked for outside any project folder."""

    code = "no-current-project"


class UnknownSecretStore(SecretStoreError, LookupError):
    """No store type is registered under that name."""

    code = "unknown-store"

    def __init__(self, type_name: str, known: Iterable[str] = ()) -> None:
        self.type_name = type_name
        super().__init__(f"no secret store type {type_name!r}; known: {', '.join(known)}")


class VaultNotEnabled(SecretStoreError):
    """The encrypted store has not been enabled on this machine yet."""

    code = "vault-disabled"


class StoreNeedsConnection(SecretStoreError):
    """A store that acts as an account was used before a connection was bound to it."""

    code = "needs-connection"

    def __init__(self, store: str, providers: Iterable[str]) -> None:
        self.store = store
        self.providers = list(providers)
        wanted = " or ".join(self.providers)
        first = self.providers[0] if self.providers else ""
        super().__init__(
            f"the {store} store has no bound connection; run "
            f'`await store.set_connection(await Connection.get("{first}"))` ({wanted})'
        )


class StoreAccessDenied(SecretStoreError, PermissionError):
    """The remote store refused the bound account (401/403). Names the scope, never a token."""

    code = "access-denied"

    def __init__(self, store: str, provider: str, scopes: Iterable[str], detail: str = "") -> None:
        self.store = store
        self.provider = provider
        self.scopes = list(scopes)
        why = f": {detail}" if detail else ""
        super().__init__(
            f"the {store} store refused the {provider} connection{why}; the grant needs "
            f"{', '.join(self.scopes)} and the account needs access to the secrets "
            "(`await connection.connect(reauthorize=True)` to consent again)"
        )


__all__ = [
    "MissingSecrets",
    "NoCurrentProject",
    "SecretStoreError",
    "StoreAccessDenied",
    "StoreNeedsConnection",
    "UnknownSecretStore",
    "VaultNotEnabled",
]
