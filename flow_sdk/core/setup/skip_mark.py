"""The setup skip mark — what "Skip → Locally" writes on a requirement's own record.

A record a project's setup lists (a Credential, a DataSource, a WebApp; the Project for a ``flow.json``
dependency) carries ``setup_skipped`` (``SetupSkipSpec`` — the Project a map of them, by dependency name). It is
PRIVATE, a person's choice on this machine: the asset file and a share never carry it.

Every other writer saves the whole row from a copy that knows nothing of the mark — the indexer re-reading the
file, a source's poller, a credential edit, a client PUT — so the mark is guarded the way a projected field is
(``core/entity/projected_fields``): no direct assignment, dropped from inbound bodies, kept through every save
but the one :func:`write_setup_skip` makes.
"""
from __future__ import annotations

from typing import Any, ClassVar, FrozenSet

from flow_sdk.core.entity.projected_fields import PROJECTION_SENTINEL, ProjectedFields

FIELD = "setup_skipped"


class SetupSkippable(ProjectedFields):
    """Mixin (listed before ``Entity``): ``setup_skipped`` is written by :func:`write_setup_skip` alone."""

    projected_fields: ClassVar[FrozenSet[str]] = frozenset({FIELD})
    projection_writer: ClassVar[str] = "core.setup.skip_mark.write_setup_skip"


async def write_setup_skip(record: Any, value: Any) -> Any:
    """Set ``record``'s mark to ``value`` (``None`` un-skips) and save it — the only save that may change it.

    The ROW only: the mark is never the asset's, so its files are not rewritten (a credential.json re-serialised
    by a skip would be a change to the project)."""
    from flow_sdk.core.entity.entity_model import suppress_store  # noqa: PLC0415

    record._set_projection(FIELD, value, PROJECTION_SENTINEL)
    with suppress_store():
        await record.save()
    return record
