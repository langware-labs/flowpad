"""DevInstanceSettings — Phase F shim.

The class body is now a thin alias for ``BaseInstanceSettings`` with the
dev port default (9008). Path layout is identical to prod (under
``instances/dev/`` rather than ``instances/prod/``) and inherited via
``BaseInstanceSettings._build_from_env``.

Kept as a separate symbol so existing imports
(``from flow_sdk.instance_settings import DevInstanceSettings``) keep
resolving. Will be fully deleted post-bake; for now it just exists for
back-compat.
"""

from __future__ import annotations

from .base_settings import BaseInstanceSettings

DEFAULT_DEV_PORT = 9008


class DevInstanceSettings(BaseInstanceSettings):
    """Dev-mode settings. Inherits everything from BaseInstanceSettings;
    only the port default differs."""

    @classmethod
    def from_env(cls) -> "DevInstanceSettings":
        return BaseInstanceSettings._build_from_env(
            cls=cls,
            instance_name="dev",
            is_dev=True,
            default_port=DEFAULT_DEV_PORT,
        )
