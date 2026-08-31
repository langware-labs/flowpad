"""SecretOrigin locators — where a declared secret's value is fetched from.

A locator is a POINTER, never a value: it is metadata, safe to persist and to
share, and it is resolved to an actual secret only at worker runtime by the
matching driver.

A locator is explicitly NOT an identity. A secret is identified by
``(project_id, env_var)`` (see ``secret_origin_identity``), which is what lets
it move between stores — ``.env.local`` → the encrypted ``sodot`` → the hub
vault — while staying the same secret. That is also why none of these carry a
``key()``.

The five variants and the discriminated union over them lived in seven modules
of five to thirty lines each; they are one closed set with one shape, so they
live together here.
"""
from __future__ import annotations

from typing import Annotated, Literal, Union

from pydantic import BaseModel, Discriminator, Tag, TypeAdapter

from flow_sdk.utils.kind_registry import kind_discriminator

DEFAULT_SECRET_ORIGIN_KIND = "local"

resolve_secret_origin_kind = kind_discriminator(DEFAULT_SECRET_ORIGIN_KIND)


class SecretOriginLocator(BaseModel):
    """Base pointer. ``kind`` selects the concrete variant on the wire."""

    kind: str = DEFAULT_SECRET_ORIGIN_KIND


class LocalSecretRef(SecretOriginLocator):
    """Local app-secret pointer.

    ``sod_name`` is the name in the existing per-instance app secret store. The
    stored value is resolved only by the local worker launcher.
    """

    kind: Literal["local"] = "local"
    sod_name: str = ""


class EnvLocalSecretRef(SecretOriginLocator):
    """Project ``.env.local`` secret pointer.

    ``env_key`` is the key name in the project's ``.env.local`` value store
    (``flow_sdk/builtin/env_local_store.py``). Machine-local like ``local``
    (sodot); the value is resolved only by the worker launcher, never
    transmitted.
    """

    kind: Literal["env-local"] = "env-local"
    env_key: str = ""


class HubSecretRef(SecretOriginLocator):
    """Flowpad Hub secret pointer.

    The hub is the system of record, and a secret there is named the same way it
    is named here: ``(project_id, ENV_VAR_NAME)``. So this locator carries those
    two fields rather than an opaque ``secret_id`` — the coordinates ARE the
    identity, and an opaque id would be a second name for the same thing, free
    to drift.

    Values resolve through ``HubSecretDriver`` against the hub's consent-gated,
    audited ``env-var/<NAME>/value`` route.
    """

    kind: Literal["flowpad-hub"] = "flowpad-hub"
    project_id: str = ""
    name: str = ""
    #: Legacy/opaque coordinate. Accepted (and read as a name fallback in
    #: ``HubSecretDriver._coords`` and ``membership_sync``) so payloads minted
    #: before the re-key still validate; never written.
    secret_id: str = ""


class GcpSecretRef(SecretOriginLocator):
    """Google Cloud Secret Manager pointer (provider slot).

    Value-free coordinates for a GCP-hosted secret. The driver is a V1 stub
    (``can_resolve`` is False → the member is routed to the setup wizard); the
    coordinates travel with the shared reference so a future real driver can
    fetch.
    """

    kind: Literal["gcp"] = "gcp"
    gcp_project: str = ""
    secret: str = ""
    version: str = "latest"


class OnePasswordSecretRef(SecretOriginLocator):
    """1Password item-field pointer (provider slot).

    Value-free coordinates. V1 driver is a stub (``can_resolve`` is False →
    setup wizard); the coordinates travel with the reference.
    """

    kind: Literal["1password"] = "1password"
    vault: str = ""
    item: str = ""
    field: str = "credential"


#: The discriminated union every persisted/shared locator validates through.
SecretOriginField = Annotated[
    Union[
        Annotated[LocalSecretRef, Tag("local")],
        Annotated[EnvLocalSecretRef, Tag("env-local")],
        Annotated[HubSecretRef, Tag("flowpad-hub")],
        Annotated[GcpSecretRef, Tag("gcp")],
        Annotated[OnePasswordSecretRef, Tag("1password")],
    ],
    Discriminator(resolve_secret_origin_kind),
]

SECRET_ORIGIN_ADAPTER: TypeAdapter = TypeAdapter(SecretOriginField)
