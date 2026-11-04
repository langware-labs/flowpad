"""What marks a project's status stale, heard on the bus.

Every entity write is announced as ``entity.created/updated/deleted`` (``db/entity_on_tag``). A write to a row the
setup status reads — a credential, a data source, a web app (its lifecycle push), a connection — marks the setup
part of every project on someone's screen stale; :func:`mark_stale` refreshes those at once and flags the rest.
Writes that are not entity writes (a credential value, an OAuth grant) call ``mark_stale`` where they happen.
"""

from __future__ import annotations

from typing import Callable

#: The entity types the setup part is read from. Never ``project``: the status push is itself a project update.
SETUP_INPUTS = frozenset({"credential", "data_source", "micro_app", "connection"})


def _on_entity(event) -> None:
    from flow_sdk.core.project_status import SETUP, mark_stale  # noqa: PLC0415

    data = getattr(event, "data", None) or {}
    if str(data.get("entity_type", "")) in SETUP_INPUTS:
        mark_stale(None, [SETUP])


def subscribe() -> Callable[[], None]:
    """Wire the bus to the project status. Returns the unsubscriber."""
    from flow_sdk.tags import on_tag  # noqa: PLC0415

    return on_tag("entity.*", _on_entity)
