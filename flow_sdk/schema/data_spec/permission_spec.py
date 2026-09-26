"""Permissions — what an asset needs to be allowed to do, named by capability, not by mechanism.

A permission is a dot-path ``permission.<provider>.<resource>.<action>`` (``permission.google.drive.read``):
the vocabulary for requirements, consent screens and least-privilege diffs. The asset that needs it
declares it with its **mapping** — how a place can satisfy it: OAuth scopes on a connection, IAM roles on
a service identity, or an API key. Raw provider scopes stay the wire truth; a permission never replaces
them. A **need** is one use of a permission (``on`` a resource, and ``why``); an **authorization** is how
one deployment satisfies one need, and whether that could be checked.
"""
from __future__ import annotations

import re
from typing import ClassVar

from pydantic import ConfigDict, Field, field_validator

from flow_sdk.schema.data_spec.spec import DataSpec

#: ``permission.<provider>.<...>`` — at least a provider and one more segment, lower snake case.
PERMISSION_RE = re.compile(r"^permission(\.[a-z][a-z0-9_]*){2,}$")

MECHANISM_OAUTH = "oauth"
MECHANISM_IAM = "iam"
MECHANISM_API_KEY = "api_key"
MECHANISMS = (MECHANISM_OAUTH, MECHANISM_IAM, MECHANISM_API_KEY)

#: Verified: checked against the grant itself (a held connection's scopes). Declared: a value is present
#: but what it allows cannot be checked (an API key). Missing: nothing here satisfies it.
STATUS_VERIFIED = "verified"
STATUS_DECLARED = "declared"
STATUS_MISSING = "missing"


def validate_permission(value: str) -> str:
    value = str(value or "").strip()
    if not PERMISSION_RE.fullmatch(value):
        raise ValueError(f"{value!r} is not a permission (permission.<provider>.<resource>[.<action>])")
    return value


def provider_of(permission: str) -> str:
    """``google`` for ``permission.google.drive.read``."""
    return permission.split(".")[1]


class PermissionMappingSpec(DataSpec):
    """How a permission is granted: the mechanism, and what it takes on the wire."""

    model_config = ConfigDict(frozen=True)
    spec_kind: ClassVar[str] = "permission.mapping"

    #: ``oauth`` / ``iam`` / ``api_key``.
    mechanism: str
    #: The connection provider an OAuth grant is held on (``google``); the permission's provider when empty.
    connector: str = ""
    #: The provider's own scope strings the grant must include. Empty: the provider's app decides them
    #: (Slack's scopes live in the hub's manifest) — holding the connection is all that can be checked.
    oauth_scopes: list[str] = Field(default_factory=list)
    iam_roles: list[str] = Field(default_factory=list)
    #: The variable whose value grants it (``OPENAI_API_KEY``) — present means declared, never verified.
    api_key: str = ""
    why: str = ""

    @field_validator("mechanism")
    @classmethod
    def _known(cls, value: str) -> str:
        if value not in MECHANISMS:
            raise ValueError(f"unknown mechanism {value!r}; expected one of {list(MECHANISMS)}")
        return value


class PermissionNeedSpec(DataSpec):
    """One use of a permission: ``on`` which resource (a bucket, a channel), and ``why``."""

    model_config = ConfigDict(frozen=True)
    spec_kind: ClassVar[str] = "permission.need"

    permission: str
    on: str = ""
    why: str = ""

    @field_validator("permission")
    @classmethod
    def _named(cls, value: str) -> str:
        return validate_permission(value)


class AuthorizationSpec(DataSpec):
    """How one deployment satisfies one permission need. Names only."""

    model_config = ConfigDict(frozen=True)
    spec_kind: ClassVar[str] = "permission.authorization"

    permission: str
    mechanism: str
    #: ``verified`` / ``declared`` / ``missing``.
    status: str
    #: What was checked, or what to do (``connect google``; ``grant drive.readonly``).
    detail: str = ""


__all__ = [
    "AuthorizationSpec",
    "MECHANISM_API_KEY",
    "MECHANISM_IAM",
    "MECHANISM_OAUTH",
    "PERMISSION_RE",
    "PermissionMappingSpec",
    "PermissionNeedSpec",
    "STATUS_DECLARED",
    "STATUS_MISSING",
    "STATUS_VERIFIED",
    "provider_of",
    "validate_permission",
]
