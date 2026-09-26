"""The permission registry: every permission a loaded asset declares, and how it is granted.

Permissions are declared by the assets that need them — a data driver's ``permissions`` in its
``data_driver.json``, a secret store's ``permissions`` ClassVar — never listed here, so no provider name
lives in generic code. The registry only collects: ``mapping(kind)`` answers how a permission is
granted, ``kinds_under(prefix)`` walks the ontology (``permission.google`` → every Google permission),
and ``needs_of_driver(name)`` is what a data source of that driver needs.
"""
from __future__ import annotations

import logging
from typing import Optional

from flow_sdk.schema.data_spec.permission_spec import (
    MECHANISM_OAUTH,
    PermissionMappingSpec,
    PermissionNeedSpec,
    provider_of,
)

logger = logging.getLogger(__name__)


def declared() -> dict[str, PermissionMappingSpec]:
    """Every permission a loaded driver or store declares. Two declarers of one permission must agree on
    how it is granted; the first wins and a disagreement is logged (an asset bug, not a runtime failure)."""
    from flow_sdk.ingest.driver_runtime import DRIVERS  # noqa: PLC0415
    from flow_sdk.secrets.store import _TYPES  # noqa: PLC0415

    sources = [(f"driver {name}", (driver.manifest.permissions if driver.manifest else {})) for name, driver in DRIVERS.items()]
    sources += [(f"store {name}", cls.permissions) for name, cls in sorted(_TYPES.items())]
    out: dict[str, PermissionMappingSpec] = {}
    for who, permissions in sources:
        for kind, mapping in permissions.items():
            first = out.setdefault(kind, mapping)
            # ``why`` is each declarer's own reason; how the permission is granted must agree.
            if first.model_dump(exclude={"why"}) != mapping.model_dump(exclude={"why"}):
                logger.warning("[permissions] %s maps %s differently from an earlier declarer; the first is kept", who, kind)
    return out


def mapping(kind: str) -> Optional[PermissionMappingSpec]:
    """How ``kind`` is granted, or ``None`` when no loaded asset declares it."""
    return declared().get(kind)


def kinds_under(prefix: str) -> list[str]:
    """Every declared permission at or below ``prefix`` (``permission.google``), sorted."""
    from flow_sdk.tags.grammar import tag_is_within  # noqa: PLC0415

    return sorted(kind for kind in declared() if tag_is_within(kind, prefix))


def oauth_grant(kind: str) -> Optional[tuple[str, list[str]]]:
    """``(connection provider, scopes)`` when ``kind`` is granted by OAuth; ``None`` otherwise (an API
    key is the credential's to provide; IAM is a deployment's grant; an undeclared kind names nothing)."""
    granted = mapping(kind)
    if granted is None or granted.mechanism != MECHANISM_OAUTH:
        return None
    return granted.connector or provider_of(kind), list(granted.oauth_scopes)


def needs_of_driver(name: str) -> list[PermissionNeedSpec]:
    """What a data source of driver ``name`` needs to be allowed to do."""
    from flow_sdk.ingest.driver_runtime import DRIVERS  # noqa: PLC0415

    driver = DRIVERS.get_or_none(name)
    permissions = driver.manifest.permissions if driver is not None and driver.manifest is not None else {}
    return [PermissionNeedSpec(permission=kind, why=m.why) for kind, m in permissions.items()]


__all__ = ["declared", "kinds_under", "mapping", "needs_of_driver", "oauth_grant"]
