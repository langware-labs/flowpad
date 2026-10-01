"""``GET <type>/<id>/open`` — the one deep-link route for every entity type.

"Open in FlowPad" on a hub page (and a notification email) hands the desktop
``/api/v1/graph/<type>/<id>/open``. This action resolves the type's class and
asks it where the link goes (the class's ``resolve_open``): it materializes
what the UI needs locally — usually from the hub, since the desktop may hold no
row yet — and returns the ``/dock/home?action=open…`` params, which become the
redirect page (``deep_link_redirect``). A type opts in by defining
``resolve_open`` and being listed in ``OPENABLE_TYPES``; every other type is
refused here.

GET only. A type with its own ``open`` action (``agentic_process.open``,
``shell.open``) keeps it — lookup prefers the type-scoped action — so such a
type is not reachable through this route.
Runs with no local row (``allow_missing_target``): that row is what the
resolver is there to fetch.
"""

from __future__ import annotations

import logging

from fastapi.responses import HTMLResponse

from flow_sdk.actions.action_registry import action
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse

logger = logging.getLogger(__name__)


#: The types a deep link may open — for now an explicit list; each has a
#: ``resolve_open``. Enforced in the handler: the dispatcher never reads an
#: action's ``types``, and a multi-type action registers under its bare name.
OPENABLE_TYPES: tuple[str, ...] = (
    BuiltinEntityType.PROJECT.value,
    BuiltinEntityType.FLOW_MESSAGE.value,
    BuiltinEntityType.NOTIFICATION.value,
)


@action.get(action_name="open", types=list(OPENABLE_TYPES), allow_missing_target=True)
async def open_entity_link() -> HTMLResponse | ApiResponse:
    from flow_sdk.server.routes.notify import deep_link_redirect  # noqa: PLC0415

    request_info = get_current_request_info()
    if not request_info or not request_info.target_entity_typeid:
        return ApiFailResponse(message="open requires an entity: <type>/<id>/open", status_code=400)
    typeid = request_info.target_entity_typeid
    if typeid.type not in OPENABLE_TYPES:
        return ApiFailResponse(message=f"A {typeid.type} can't be opened from a link", status_code=400)
    cls = SchemaRegistry.get_entity_cls(typeid.type)
    try:
        link = await cls.resolve_open(str(typeid.id), request_info.someone_typeid)
    except Exception as e:  # noqa: BLE001 — the browser gets a reason, not a stack
        logger.error("[open] %s: %s", typeid, e, exc_info=True)
        return ApiFailResponse(message=f"Open failed: {e}")
    return deep_link_redirect(link)
