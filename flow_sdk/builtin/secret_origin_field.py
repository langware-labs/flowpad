"""Discriminated union for SecretOrigin locators."""
from __future__ import annotations

from typing import Annotated, Union

from pydantic import Discriminator, Tag, TypeAdapter

from flow_sdk.builtin.hub_secret_ref import HubSecretRef
from flow_sdk.builtin.local_secret_ref import LocalSecretRef
from flow_sdk.builtin.secret_origin_locator import resolve_secret_origin_kind

SecretOriginField = Annotated[
    Union[
        Annotated[LocalSecretRef, Tag("local")],
        Annotated[HubSecretRef, Tag("flowpad-hub")],
    ],
    Discriminator(resolve_secret_origin_kind),
]

SECRET_ORIGIN_ADAPTER: TypeAdapter = TypeAdapter(SecretOriginField)
