"""``icons`` graph action — hand the frontend the icon vocabulary.

The packs also ride along on ``/api/v1/graph/bootstrap`` (``icon_packs``), which
is where the frontend normally gets them: they are static and definitional, like
``types``, so they belong in the payload that is already fetched once at startup
rather than in a second round-trip.

This action exists for everything that is not that frontend — a standalone page,
a plugin, a script checking a name — and for a client that wants the packs
without the rest of a bootstrap. It is the same payload from the same registry.
"""

from __future__ import annotations

from flow_sdk.actions.action_registry import action
from flow_sdk.icons import icons
from flow_sdk.responses.response import ApiResponse, ApiSuccessResponse


@action.get(action_name="icons", types=None)
async def get_icons() -> ApiResponse:
    """Every icon pack this backend serves, in resolution order."""
    return ApiSuccessResponse(data={"icon_packs": icons.payload()})
