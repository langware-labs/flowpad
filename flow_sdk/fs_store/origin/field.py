"""``OriginField`` — the discriminated union every ``origin`` field is typed as.

The discriminator is a callable so the tag set stays open at the cloud end and
tolerant at the git end: a dict with no ``kind`` is a legacy git origin, a
git-hosting name folds onto ``git``, ``local`` is local, and any other kind is a
``CloudOrigin`` (whose ``kind`` is the CHANNEL — gmail, slack, gcp — an open string).

``SoftOrigin`` is the same type with the ONE tolerance rule attached: a malformed
value becomes ``None`` rather than breaking the entity that merely carries it.
"""

from __future__ import annotations

import logging
from typing import Annotated, Any, Optional, Union

from pydantic import Discriminator, Tag, TypeAdapter, ValidationError, WrapValidator

from flow_sdk.fs_store.origin.cloud_origin import CloudOrigin
from flow_sdk.fs_store.origin.fs_origin import ORIGIN_KIND_ALIASES, resolve_origin_kind
from flow_sdk.fs_store.origin.git_origin import GitOrigin
from flow_sdk.fs_store.origin.local_origin import LocalOrigin

logger = logging.getLogger(__name__)


def origin_tag(value: Any) -> str:
    """The union arm a raw origin belongs to: ``git`` / ``local`` / ``cloud``."""
    kind = ORIGIN_KIND_ALIASES.get(resolve_origin_kind(value).lower(), resolve_origin_kind(value).lower())
    return kind if kind in ("git", "local") else "cloud"


OriginField = Annotated[
    Union[
        Annotated[GitOrigin, Tag("git")],
        Annotated[LocalOrigin, Tag("local")],
        Annotated[CloudOrigin, Tag("cloud")],
    ],
    Discriminator(origin_tag),
]


def _soft(value: Any, handler: Any) -> Any:
    if value == "":
        return None
    try:
        return handler(value)
    except ValidationError:
        logger.warning("unparseable origin %r; treating as absent", value)
        return None


SoftOrigin = Annotated[Optional[OriginField], WrapValidator(_soft)]

# Cache the adapters — TypeAdapter compiles a full validation schema for the
# union; rebuilding it per call (e.g. once per bundle entry on unpack) is the
# expensive part pydantic warns about. Reuse these everywhere.
ORIGIN_ADAPTER: TypeAdapter = TypeAdapter(SoftOrigin)
