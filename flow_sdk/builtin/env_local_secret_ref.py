"""Project ``.env.local`` secret pointer.

``env_key`` is the key name in the project's ``.env.local`` value store
(``flow_sdk/builtin/env_local_store.py``). Machine-local like ``local`` (sodot);
the value is resolved only by the worker launcher, never transmitted.
"""
from __future__ import annotations

from typing import Literal

from flow_sdk.builtin.secret_origin_locator import SecretOriginLocator


class EnvLocalSecretRef(SecretOriginLocator):
    kind: Literal["env-local"] = "env-local"
    env_key: str = ""
