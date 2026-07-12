"""SecretOrigin locator value objects.

A SecretOrigin locator is a pointer to where a secret value can be resolved at
worker runtime. It is metadata only: locators are safe to persist and share
because they never contain the secret value.
"""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel

DEFAULT_SECRET_ORIGIN_KIND = "local"


def resolve_secret_origin_kind(value: Any) -> str:
    if isinstance(value, dict):
        return str(value.get("kind") or DEFAULT_SECRET_ORIGIN_KIND)
    return str(getattr(value, "kind", DEFAULT_SECRET_ORIGIN_KIND) or DEFAULT_SECRET_ORIGIN_KIND)


class SecretOriginLocator(BaseModel):
    kind: str = DEFAULT_SECRET_ORIGIN_KIND

    def key(self) -> str:
        from flow_sdk.builtin.secret_origin_driver import get_secret_origin_driver  # noqa: PLC0415

        return get_secret_origin_driver(self.kind).key(self)
