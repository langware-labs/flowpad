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
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse

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


@action.post(action_name="new-cloud-projects", types=None)
async def new_cloud_projects() -> ApiResponse:
    """The hub projects this desktop has never seen, each as the set-up link
    ``IncomingDeepLink`` would read (``Project.new_from_hub``). The UI calls it
    once a session is signed in and offers each one's set-up."""
    from flow_sdk.builtin.project import Project  # noqa: PLC0415

    request_info = get_current_request_info()
    someone_typeid = request_info.someone_typeid if request_info else None
    links = await Project.new_from_hub(someone_typeid)
    return ApiSuccessResponse(data={"projects": [link.model_dump(exclude_none=True) for link in links]})


@action.post(action_name="install-from-hub", types=[BuiltinEntityType.PROJECT.value], allow_missing_target=True)
async def install_project_from_hub() -> ApiResponse:
    """``POST project/<id>/install-from-hub`` ``{name}`` — a hub project this desktop
    holds no row for, mirrored and set up under the receiver's ``name``: the answer
    to a ``new-cloud-projects`` link whose own name is a project here already.
    Refused like an invite's install (409 ``project_name_conflict``) when ``name``
    is taken too."""
    from flow_sdk.builtin.project import DuplicateProjectNameError, Project  # noqa: PLC0415
    from flow_sdk.cloud_client.shared.errors import HubError  # noqa: PLC0415
    from flow_sdk.core.wizard.first_run import require_first_run_setup  # noqa: PLC0415

    await require_first_run_setup()
    request_info = get_current_request_info()
    if not request_info or not request_info.target_entity_typeid:
        return ApiFailResponse(
            message="install-from-hub requires a project: project/<id>/install-from-hub", status_code=400
        )
    body = await request_info.get_post_data() or {}
    name = str(body.get("name") or "").strip()
    if not name:
        return ApiFailResponse(message="install-from-hub requires a name", status_code=400)
    try:
        project = await Project.hydrate_from_hub(
            str(request_info.target_entity_typeid.id), request_info.someone_typeid, name=name
        )
    except DuplicateProjectNameError as e:
        return ApiFailResponse(
            message=f"you already have a project named {e.existing.name!r}",
            status_code=409,
            data=await e.conflict(name),
        )
    except HubError as e:
        return ApiFailResponse(message=f"The hub can't be reached: {e}", status_code=502)
    if project is None:
        return ApiFailResponse(message="That project is no longer available.", status_code=404)
    try:
        return ApiSuccessResponse(data=await project.setup_from_git_origin())
    except Exception as exc:  # noqa: BLE001 — the receiver gets the reason (a failed clone), not a stack
        return ApiFailResponse(message=str(exc), status_code=400)
