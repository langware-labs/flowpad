"""``OriginField`` — the discriminated union every ``origin`` field is typed as.

The discriminator is a callable so the tag set stays open at the cloud end and
tolerant at the git end: a dict with no ``kind`` is a legacy git origin, a
git-hosting name folds onto ``git``, ``local`` is local, and any other kind is a
``CloudOrigin`` (whose ``kind`` is the CHANNEL — gmail, slack, gcp — an open string).

``OriginField`` carries the ONE tolerance rule: a malformed value becomes ``None``
rather than breaking the entity that merely carries it.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Annotated, Any, Optional, Union

from pydantic import Discriminator, Tag, TypeAdapter, ValidationError, WrapValidator

import flow_sdk.fs_store.origin.cloud_origin  # noqa: F401 — registers the cloud arm
import flow_sdk.fs_store.origin.git_origin  # noqa: F401 — registers the git arm
import flow_sdk.fs_store.origin.hub_repo_origin  # noqa: F401 — registers the hub-repo arm
import flow_sdk.fs_store.origin.local_origin  # noqa: F401 — registers the local arm
from flow_sdk.fs_store.origin.fs_origin import CLOUD_ORIGIN_KIND, ORIGIN_MODELS, resolve_origin_kind

if TYPE_CHECKING:
    from flow_sdk.fs_store.origin.git_origin import GitOrigin
    from flow_sdk.fs_store.origin.hub_repo_origin import HubRepoOrigin

logger = logging.getLogger(__name__)


_ARMS = frozenset(ORIGIN_MODELS.kinds())   # the union is frozen at import; so is this


def origin_tag(value: Any) -> str:
    """The union arm a raw origin belongs to — a registered FS kind, else cloud."""
    kind = ORIGIN_MODELS.normalize(resolve_origin_kind(value))
    return kind if kind in _ARMS else CLOUD_ORIGIN_KIND


# The arms ARE the registry: every model registered itself where it is defined
# (the modules above import eagerly, so the table is complete here).
_ORIGIN_UNION = Annotated[
    Union[tuple(Annotated[model, Tag(kind)] for kind, model in ORIGIN_MODELS.items())],
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


#: THE origin type: the union plus the one tolerance rule — a malformed value
#: reads as absent rather than breaking the entity that merely carries it.
OriginField = Annotated[Optional[_ORIGIN_UNION], WrapValidator(_soft)]

# Cache the adapters — TypeAdapter compiles a full validation schema for the
# union; rebuilding it per call (e.g. once per bundle entry on unpack) is the
# expensive part pydantic warns about. Reuse these everywhere.
ORIGIN_ADAPTER: TypeAdapter = TypeAdapter(OriginField)


def as_project_origin(origin: Any) -> "Optional[Union[GitOrigin, HubRepoOrigin]]":
    """Narrow to an origin a whole project can be checked out from — its git
    repository, or the hub-hosted copy of it. ``None`` for absent, malformed, or
    an origin a project cannot be cloned from (a local path, a cloud channel)."""
    from flow_sdk.fs_store.origin.git_origin import GitOrigin  # noqa: PLC0415
    from flow_sdk.fs_store.origin.hub_repo_origin import HubRepoOrigin  # noqa: PLC0415

    typed = origin if isinstance(origin, (GitOrigin, HubRepoOrigin)) else ORIGIN_ADAPTER.validate_python(origin)
    return typed if isinstance(typed, (GitOrigin, HubRepoOrigin)) else None
