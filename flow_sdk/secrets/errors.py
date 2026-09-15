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


__all__ = ["MissingSecrets", "NoCurrentProject", "SecretStoreError", "UnknownSecretStore", "VaultNotEnabled"]
