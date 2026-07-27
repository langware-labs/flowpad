"""Discriminated union for SecretOrigin locators."""
from __future__ import annotations

from typing import Annotated, Union

from pydantic import Discriminator, Tag, TypeAdapter

from flow_sdk.builtin.env_local_secret_ref import EnvLocalSecretRef
from flow_sdk.builtin.gcp_secret_ref import GcpSecretRef
from flow_sdk.builtin.hub_secret_ref import HubSecretRef
from flow_sdk.builtin.local_secret_ref import LocalSecretRef
from flow_sdk.builtin.onepassword_secret_ref import OnePasswordSecretRef
from flow_sdk.builtin.secret_origin_locator import resolve_secret_origin_kind

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
