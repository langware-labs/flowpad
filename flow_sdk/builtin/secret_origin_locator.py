"""SecretOrigin locator value objects.

A SecretOrigin locator is a pointer to where a secret value can be resolved at
worker runtime. It is metadata only: locators are safe to persist and share
because they never contain the secret value.
"""
from __future__ import annotations

from pydantic import BaseModel

from flow_sdk.utils.kind_registry import kind_discriminator

DEFAULT_SECRET_ORIGIN_KIND = "local"


resolve_secret_origin_kind = kind_discriminator(DEFAULT_SECRET_ORIGIN_KIND)


class SecretOriginLocator(BaseModel):
    """Where a declared secret's value is fetched from — declaration detail.

    Deliberately has no ``key()``: a locator is NOT an identity. A secret is
    identified by ``(project_id, env_var)`` (see ``secret_origin_identity``),
    which is what lets it move between stores while staying the same secret.
    """

    kind: str = DEFAULT_SECRET_ORIGIN_KIND
