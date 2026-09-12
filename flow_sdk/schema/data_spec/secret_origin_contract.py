"""Filesystem contracts independent of application entities."""
from __future__ import annotations

import re
from typing import Any

SECRET_ORIGIN_ENV_VAR_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


SOD_STORE_SODOT = "sodot"


SOD_STORE_ENV_LOCAL = "env-local"


_FORBIDDEN_VALUE_KEYS = {
    "value",
    "secret_value",
    "plaintext",
    "plain_value",
    # A salted digest is kept per-machine in the encrypted sodot and must never
    # reach a reference json or a hub payload. Naming it here makes a refactor
    # that tries fail loudly instead of leaking quietly.
    "digest",
    "value_digest",
    "value_hash",
}


def is_valid_secret_origin_env_var(env_var: str) -> bool:
    return bool(SECRET_ORIGIN_ENV_VAR_RE.fullmatch(env_var))


def assert_value_free(data: Any, *, where: str = "secret reference") -> None:
    """Raise if ``data`` (a reference json / share payload) contains any
    plaintext-value-looking key at any depth. The reference must be a pointer only."""
    if isinstance(data, dict):
        for k, v in data.items():
            if isinstance(k, str) and k.strip().lower() in _FORBIDDEN_VALUE_KEYS:
                raise ValueError(f"{where} must be value-free; found forbidden key {k!r}")
            assert_value_free(v, where=where)
    elif isinstance(data, (list, tuple)):
        for item in data:
            assert_value_free(item, where=where)


LM_SECRET_PREFIX = "lm_api."
