"""Place a webapp asset when it is indexed, and unplace it when it goes.

An indexed webapp is served by a ``static`` endpoint of its project's local
placement (``builtin.webapp_placement.place_webapp_locally``); these are the
``post_sync_fn`` / ``orphan_cascade_fn`` that run it. Lives under
``fs_store/operations`` (not ``builtin``) so the type info can import it without
pulling ``Entity`` in at import time; everything heavy is imported inside.
"""

from __future__ import annotations


async def place_indexed_webapp(record) -> None:
    """``post_sync_fn``: an indexed webapp is served by a ``static`` endpoint here."""
    from flow_sdk.builtin.faas.micro_app import WebApp  # noqa: PLC0415
    from flow_sdk.builtin.webapp_placement import place_webapp_locally  # noqa: PLC0415

    app = await WebApp.get_by_id(str(record.id))
    if app is not None:
        await place_webapp_locally(app)


async def unplace_webapp(entity_id: str) -> None:
    """``orphan_cascade_fn``: a removed webapp takes the endpoints that served it."""
    from flow_sdk.builtin import webapp_placement  # noqa: PLC0415

    await webapp_placement.unplace_webapp(entity_id)
