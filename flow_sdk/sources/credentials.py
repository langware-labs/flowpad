"""``Credentials`` — the one shape a secret reaches a source in.

Resolved by the application from a manifest's ``auth`` (an OAuth connector, declared
environment variables, or per-row secrets) and handed to the source inside its binding.
Values are ``SecretStr``: a dump masks them, ``wire()`` reveals them for the one frame that
crosses to a source host. Never the process environment, never the row's ``config``.
"""

from __future__ import annotations

from typing import ClassVar, Optional

from pydantic import AwareDatetime, SecretStr

from flow_sdk._compat import StrEnum
from flow_sdk.schema.data_spec.spec import DataSpec


class AuthShape(StrEnum):
    NONE = "none"
    CONNECTOR = "connector"
    ENV = "env"
    SECRETS = "secrets"


class Credentials(DataSpec):
    spec_kind: ClassVar[str] = "source.credentials"

    shape: AuthShape = AuthShape.NONE
    #: An OAuth or API token, for the ``connector`` shape.
    token: Optional[SecretStr] = None
    scopes: tuple[str, ...] = ()
    #: Who the token acts as, when the connection knows.
    identity: str = ""
    expires_at: Optional[AwareDatetime] = None
    #: Named values for the ``env`` and ``secrets`` shapes.
    values: dict[str, SecretStr] = {}

    def wire(self) -> dict:
        """The revealed form, for the one hop into a source host."""
        return {
            "shape": self.shape.value,
            "token": self.token.get_secret_value() if self.token else None,
            "scopes": list(self.scopes),
            "identity": self.identity,
            "expires_at": self.expires_at.isoformat() if self.expires_at else None,
            "values": {k: v.get_secret_value() for k, v in self.values.items()},
        }

    def value(self, name: str) -> str:
        """One named value, revealed. ``KeyError`` names the missing entry."""
        return self.values[name].get_secret_value()


__all__ = ["AuthShape", "Credentials"]
