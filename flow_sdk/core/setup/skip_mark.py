"""The setup marks a record carries for THIS machine: the skip mark, and the load stamp.

A record a project's setup lists (a Credential, a DataSource, a WebApp; the Project for a ``flow.json``
dependency) carries ``setup_skipped`` (``SetupSkipSpec`` — the Project a map of them, by dependency name). It is
PRIVATE, a person's choice on this machine: the asset file and a share never carry it. A record with a ``load``
(a WebApp) also carries ``setup_loaded`` (``SetupLoadSpec``): its load reached its goal here once
(``core/setup/load``). Same privacy, same guard.

Every other writer saves the whole row from a copy that knows nothing of the mark — the indexer re-reading the
file, a source's poller, a credential edit, a client PUT — so the mark is guarded the way a projected field is
(``core/entity/projected_fields``): no direct assignment, dropped from inbound bodies, kept through every save
but the one :func:`write_setup_skip` makes.
"""
from __future__ import annotations

from typing import Any, ClassVar, FrozenSet

from flow_sdk.core.entity.projected_fields import PROJECTION_SENTINEL, ProjectedFields

FIELD = "setup_skipped"
LOAD_FIELD = "setup_loaded"


class SetupSkippable(ProjectedFields):
    """Mixin (listed before ``Entity``): ``setup_skipped`` is written by :func:`write_setup_skip` alone."""

    projected_fields: ClassVar[FrozenSet[str]] = frozenset({FIELD})
    projection_writer: ClassVar[str] = "core.setup.skip_mark.write_setup_skip"


class SetupLoadable(SetupSkippable):
    """A skippable record that is also LOADED (a WebApp): ``setup_loaded`` is :func:`write_setup_load`'s alone."""

    projected_fields: ClassVar[FrozenSet[str]] = frozenset({FIELD, LOAD_FIELD})
    projection_writer: ClassVar[str] = "core.setup.skip_mark.write_setup_skip / write_setup_load"


async def write_setup_skip(record: Any, value: Any) -> Any:
    """Set ``record``'s mark to ``value`` (``None`` un-skips) and save it — the only save that may change it.

    The ROW only: the mark is never the asset's, so its files are not rewritten (a credential.json re-serialised
    by a skip would be a change to the project)."""
    from flow_sdk.core.entity.entity_model import suppress_store  # noqa: PLC0415

    record._set_projection(FIELD, value, PROJECTION_SENTINEL)
    with suppress_store():
        await record.save()
    return record


async def write_setup_load(record: Any, value: Any) -> Any:
    """Set ``record``'s load stamp to ``value`` (``None`` clears it) and save it — the only save that may.

    The ROW only, as :func:`write_setup_skip`: the stamp is this machine's, never the asset's."""
    from flow_sdk.core.entity.entity_model import suppress_store  # noqa: PLC0415

    record._set_projection(LOAD_FIELD, value, PROJECTION_SENTINEL)
    with suppress_store():
        await record.save()
    return record
