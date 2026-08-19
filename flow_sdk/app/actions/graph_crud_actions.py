from json import JSONDecodeError

from fastapi import HTTPException, Request
from pydantic import ValidationError

from flow_sdk import service_log
from flow_sdk.actions import action
from flow_sdk.builtin.user import User
from flow_sdk.builtin.visitor import Visitor
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.db.drivers.query import QueryFilter
from flow_sdk.flowpad_types.enums.auth_enums import AuthRole
from flow_sdk.fs_store.fs_record import AssetPathCollisionError
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse
from flow_sdk.server.routes.graph import get_by_id, get_entity_model_from_registry


# noinspection PyUnusedLocal
async def handle_query_resource(request: Request):
    request_info = get_current_request_info()
    if not request_info:
        raise HTTPException(status_code=400, detail="invalid request info")
    if request_info.direct_resource_type is None:
        raise HTTPException(status_code=400, detail="resource not available for query")
    entity_model: type[Entity] | None = SchemaRegistry.get_entity_cls(request_info.direct_resource_type)
    if not entity_model:
        raise HTTPException(
            status_code=400,
            detail=f"Query resource error: Unknown entity type: {request_info.direct_resource_type}",
        )
    filter_params = request_info.request_parameters.get("filter", {})
    entities_filter = QueryFilter.parse(filter_params, entity_model.get_type())
    _apply_top_level_paging(request_info, entities_filter)
    source_entity = request_info.target_entity_typeid
    if source_entity is None:  # TODO, We need to validate parent access
        source_entity = request_info.user
    if source_entity is None:
        raise HTTPException(status_code=400, detail="Invalid source entity")
    entities_filter.expand_auth_scopes = request_info.expand_auth_scopes
    entities_filter.expand_permissions = request_info.expand_permissions
    entities_filter.expand_is_private = request_info.expand_is_private
    entities_filter.expand_blobs = request_info.expand_blobs
    _all = await entity_model.get_all(entities_filter, source_entity)
    # Hide SDK-shipped system entities by default. Callers opt in with
    # ?include_system=true on the request (or include_system: true in the filter).
    include_system = _request_wants_system(request_info, filter_params)
    if not include_system:
        _all = [e for e in _all if not getattr(e, "system", False)]
    return ApiSuccessResponse[list[Entity]](data=_all)


def _apply_top_level_paging(request_info, entities_filter) -> None:
    """Honor ?limit= / ?offset= query params on graph list requests.

    Historically only ``limit``/``offset`` INSIDE the ``filter`` JSON were
    honored; a top-level ``?limit=5000`` was silently dropped, turning
    intended-bounded list calls into full-corpus dumps. Filter-JSON values
    win when both are set; malformed values are ignored.
    """
    params = request_info.request_parameters
    for field in ("limit", "offset"):
        if getattr(entities_filter, field, None) is not None:
            continue
        raw = params.get(field)
        if raw is None:
            continue
        try:
            value = int(raw)
        except (TypeError, ValueError):
            service_log.debug(f"[graph read] ignoring malformed ?{field}={raw!r}")
            continue
        if value >= 0:
            setattr(entities_filter, field, value)


def _request_wants_system(request_info, filter_params) -> bool:
    """Return True when the caller asked to include system entities.

    Checked in three places (any one wins): ?include_system=1 query string,
    include_system key inside filter JSON body, or X-Include-System header.
    """

    def _truthy(v) -> bool:
        if isinstance(v, bool):
            return v
        if isinstance(v, str):
            return v.lower() in ("1", "true", "yes", "on")
        return bool(v)

    params = getattr(request_info, "request_parameters", {}) or {}
    if _truthy(params.get("include_system")):
        return True
    return isinstance(filter_params, dict) and _truthy(filter_params.get("include_system"))


async def handle_get_by_id():
    request_info = get_current_request_info()
    if not request_info:
        raise HTTPException(status_code=400, detail="invalid request info")
    if request_info.target_entity_typeid is None:
        raise HTTPException(status_code=400, detail="target not available")
    entity_model, entity = await get_by_id(request_info.target_entity_typeid)
    # Schedule background record refresh (non-blocking)
    if entity is not None and hasattr(entity, "check_and_refresh_record"):
        import asyncio

        asyncio.create_task(entity.check_and_refresh_record())
    return ApiSuccessResponse[entity_model](data=entity)


@action.all(action_name="read", methods="get", types="all")
async def handle_get(request: Request):
    request_info = get_current_request_info()
    if not request_info:
        raise HTTPException(status_code=400, detail="invalid request info")
    if request_info.direct_resource_type is not None:
        return await handle_query_resource(request)
    if request_info.target_entity_typeid is not None:
        return await handle_get_by_id()
    raise HTTPException(status_code=400, detail="Invalid path for read action")


@action.all(action_name="delete", methods=["delete"], types="all")
async def handle_delete_by_id():
    request_info = get_current_request_info()
    if not request_info:
        raise HTTPException(status_code=400, detail="invalid request info")
    if request_info.target_entity_typeid is None:
        raise HTTPException(status_code=400, detail="target not available")
    target_typeid = request_info.target_entity_typeid
    if target_typeid.id is None:
        raise HTTPException(status_code=400, detail="missing entity id")
    entity_model: type[Entity] = SchemaRegistry.get_entity_cls(target_typeid.type)
    if not entity_model:
        raise HTTPException(
            status_code=400,
            detail=f"Delete error: Unknown entity type: {target_typeid.type}",
        )

    # A Hub message materializer runs detached from the HTTP request and may
    # already be in flight. Tombstone a Conversation before deleting its row so
    # that task cannot recreate the parent after this action returns.
    if target_typeid.type == BuiltinEntityType.CONVERSATION.value:
        from flow_sdk.cloud_client.hub_bridge import hub_ws_bridge  # noqa: PLC0415

        hub_ws_bridge.suppress_conversation_materialization(target_typeid.id)

    # Auto-propagate removal — symmetric with ``handle_create_entity``'s auto-share.
    # Create makes a ``remote`` child a hub ``is_child`` (the hub fans
    # ``child_created`` to the parent's watchers); delete must do the inverse:
    # remove the hub row so the hub fans ``child_deleted`` (remove_child) carried
    # on the parent. Without this the deletion never leaves the deleter's instance.
    # Server-owned, so the FE just calls delete (no ``Hub-Reflect`` opt-in). Non-fatal.
    # Scoped to ``is_child`` entities (a ``parent_type_id`` is set) — the mirror of
    # create's child-only auto-share; a top-level shared entity (no parent) keeps
    # its explicit ``unshare`` semantics and is not auto-removed from the hub here.
    entity = await entity_model.get_one({"id": target_typeid.id})
    if entity is not None and getattr(entity, "remote", False) and getattr(entity, "parent_type_id", None):
        try:
            await entity.unshare(recursive=False)
        except Exception as e:  # noqa: BLE001
            service_log.warn(f"[delete] auto-unshare {target_typeid} failed (non-fatal): {e}")

    is_deleted = await entity_model.delete_by_id(target_typeid.id)
    if not is_deleted:
        raise HTTPException(
            status_code=403,
            detail=f"Delete entity failed: {target_typeid.type}(id:{target_typeid.id})",
        )
    return ApiSuccessResponse[bool](data=is_deleted, message="Entity was deleted successfully.")


@action.all(action_name="update", methods=["put", "patch"], types="all")
async def handle_update_by_id(request: Request):
    request_info = get_current_request_info()
    if not request_info:
        raise HTTPException(status_code=400, detail="invalid request info")
    try:
        data = await request_info.get_post_data()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"invalid data format for update: {e}")
    if request_info.target_entity_typeid is None:
        raise HTTPException(status_code=400, detail="target not available")
    if not data:
        raise HTTPException(status_code=400, detail="missing data for update")
    if not isinstance(data, dict):
        raise HTTPException(status_code=400, detail="invalid data format for update")
    target_typeid = request_info.target_entity_typeid
    if target_typeid.id is None:
        raise HTTPException(status_code=400, detail="missing entity id")
    entity_model: type[Entity] = SchemaRegistry.get_entity_cls(target_typeid.type)
    if not entity_model:
        raise HTTPException(
            status_code=400,
            detail=f"Update error: Unknown entity type: {target_typeid.type}",
        )
    field_names = data.keys()
    fields_to_remove = []
    for field_name in field_names:
        if not entity_model.is_api_field(field_name):
            service_log.warning(f"Update warning: Invalid field: {field_name} for entity type: {target_typeid.type}")
            # raise HTTPException(
            #     status_code=400,
            #     detail=f"Update error: Invalid field: {field_name} for entity type: {target.type}",
            # )
            fields_to_remove.append(field_name)
    for field_name in fields_to_remove:
        del data[field_name]
    entity = await entity_model.update_by_id(target_typeid.id, data)
    if not entity:
        raise HTTPException(
            status_code=403,
            detail=f"Entity not found to update: {target_typeid.type}(id:{target_typeid.id})",
        )

    return ApiSuccessResponse[entity_model](data=entity)


@action.get(action_name="record", types="all")
async def handle_record_action():
    request_info = get_current_request_info()
    if not request_info:
        raise HTTPException(status_code=400, detail="invalid request info")
    sub = (request_info.sub_path or "").strip("/")
    if sub != "refs":
        raise HTTPException(status_code=400, detail=f"Unknown record sub-action: {sub!r}")
    if request_info.target_entity_typeid is None:
        raise HTTPException(status_code=400, detail="target not available")

    entity_model, entity = await get_by_id(request_info.target_entity_typeid)
    if entity is None:
        raise HTTPException(status_code=404, detail="Entity not found")

    rec = await entity.get_record()
    if rec is None and getattr(entity, "uname", None):
        # Try by uname as well
        from flow_sdk.fs_store.fs_record import FSRecord

        rec = FSRecord.load_or_none(entity.type, entity.uname)
    if rec is None:
        return ApiFailResponse(message="Record not found", status_code=404)

    from flow_sdk.assets.entity_vfs import local_asset_vfs_binding

    asset_binding = local_asset_vfs_binding(entity)
    if asset_binding is not None:
        type_id = str(entity.typeid)
        return ApiSuccessResponse(
            data={
                "record_folder_ref": {
                    "path": "/",
                    "ref_type": "folder",
                    "read_only": False,
                    "type_id": type_id,
                },
                "main_ref": {
                    "path": asset_binding.main_ref,
                    "ref_type": "file",
                    "read_only": False,
                    "type_id": type_id,
                },
            }
        )

    # Other local records retain their filesystem provider (normally
    # compute_node-@local); their refs are not entity-VFS assets.
    record_folder_ref_dict = rec.record_folder_ref.to_dict() if rec.record_folder_ref is not None else None
    main_ref_dict = rec.main_ref.to_dict() if rec.main_ref is not None else None

    return ApiSuccessResponse(data={"record_folder_ref": record_folder_ref_dict, "main_ref": main_ref_dict})


#: Types whose birth path is not "POST the fields". The value is the verb that
#: IS correct, so the refusal tells the caller where to go instead of just no.
_ALTERNATE_BIRTH_PATH: dict[str, str] = {
    "source_item": "POST /api/v1/ingest/items (or `flow record create source_item`) — "
    "the ingestor owns this type's identity resolution and content digest",
}


def _uncreatable_reason(type_name: str | None) -> str | None:
    """``None`` when the generic create may proceed, else why it may not.

    Deliberately keyed on an explicit map rather than ``TypeInfo.creatable``:
    77 of 93 shipped types are ``creatable=False``, including ``agentic_process``,
    ``comment``, ``project`` and ``shell``, all of which are created through this
    route in normal operation. ``creatable`` is a UI affordance hint ("offer a
    New button"), not an API authorization flag — reading it here would break
    most of the app. Only types with a genuinely different birth path belong in
    the map above.
    """
    if not type_name:
        return None
    alternate = _ALTERNATE_BIRTH_PATH.get(type_name)
    return f"{type_name} cannot be created directly — use {alternate}" if alternate else None


@action.all(action_name="create", methods="post", types="all")
async def handle_create_entity(request: Request):
    request_info = get_current_request_info()
    if not request_info or request_info.direct_resource_type is None:
        err_msg = "Post not supported for this path"
        service_log.highlighted_error(err_msg)
        raise HTTPException(status_code=400, detail=err_msg)
    try:
        data = await request_info.get_post_data()
    except JSONDecodeError:
        data = {}
    except Exception as e:
        err_msg = f"Invalid request data: {e}"
        service_log.highlighted_error(err_msg)
        raise HTTPException(status_code=400, detail=err_msg)

    # Some types have a different birth path — SourceItem is minted by the
    # ingestor, which resolves it against its natural key and computes the
    # digest. Without this gate a caller can POST one here and get a row with an
    # empty digest and no stream/external id: it looks real, is FTS-indexed, and
    # never converges with what the poller writes. Permanent duplicates.
    problem = _uncreatable_reason(request_info.direct_resource_type)
    if problem:
        raise HTTPException(status_code=400, detail=problem)

    # Get the entity model using the new helper function
    entity_model = get_entity_model_from_registry(request_info.direct_resource_type)
    type_info = SchemaRegistry.get(request_info.direct_resource_type)
    try:
        sanitized_data = {}
        for key, value in data.items():
            # Fresh user-authorable owned assets always derive placement fields
            # from the addressed scope + TypeInfo. They are returned to clients
            # for navigation/filtering, but accepting them on create would let
            # a caller author outside (or mislabel) the selected Project/User.
            if (
                key in {"asset_ref", "parent_path", "project_id", "scope"}
                and type_info is not None
                and type_info.creatable
                and type_info.owns_main_ref
            ):
                # Placement comes from the URL for a type that owns its file —
                # `POST /graph/project/<id>/<type>` — never from the body. But
                # REFUSE rather than drop: silently ignoring a placement key
                # returns 200 for an asset that landed somewhere else entirely,
                # and the caller only finds out much later (a deploy that says
                # "Asset has no owning Project"). The UI already uses the scoped
                # route; this only reaches a hand-built call.
                if value:  # the caller actually asked for a placement
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            f"{key!r} cannot be set in the body for {request_info.direct_resource_type!r} — "
                            f"it owns its file, so its placement comes from the URL. "
                            f"POST to /api/v1/graph/project/<project_id>/{request_info.direct_resource_type} instead."
                        ),
                    )
                continue
            if not entity_model.is_api_field(key):
                service_log.highlighted_error(
                    f"None API field !!!: {key} for entity type: {request_info.direct_resource_type}"
                )
                continue
            sanitized_data[key] = value
        entity: Entity = entity_model.model_validate(sanitized_data)
        # Assign deterministic ID if entity is new (not yet in DB)
        if not entity.created_by:
            entity.id = entity_model.allocate_id(entity.model_dump())
    except ValidationError as e:
        err_msg = f"Invalid request data, missing required field: {e}"
        service_log.highlighted_error(err_msg)
        raise HTTPException(status_code=400, detail=err_msg)

    # Reject agent creation without a name
    if request_info.direct_resource_type == "subagent" and not getattr(entity, "name", None):
        raise HTTPException(status_code=400, detail="Agent must have a name")

    someone_typeid = request_info.someone_typeid
    if not someone_typeid:
        raise HTTPException(status_code=400, detail="invalid auth result")

    # Entity-level save validation (a `save()` raising ValueError, e.g. Tag's
    # reserved-root gate) is a client error, not a server fault — mapped once
    # around the whole branch dispatch so every create path agrees.
    try:
        entity = await _dispatch_create_save(entity, request_info, someone_typeid)
    except AssetPathCollisionError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    # TODO Turn off expand_permissions upon entity creation
    await entity.expand_permissions()

    return ApiSuccessResponse[Entity](data=entity)


async def _dispatch_create_save(entity: Entity, request_info, someone_typeid) -> Entity:
    """The three create arms (standalone / visitor / parented), extracted so
    handle_create_entity can wrap them under one ValueError→400 mapping."""
    if not request_info.target_entity_typeid or request_info.target_entity_typeid.type == User.get_type():
        entity = await entity.save(someone_typeid)
    elif request_info.target_entity_typeid.type == Visitor.get_type():
        entity = await entity.save()
        await entity.set_visitor_role(AuthRole.ANONYMOUS_VIEWER.value.lower())
    else:
        target_entity: Entity | None = await request_info.get_target_entity()
        # we will not get to this if anymore because it is caught in the Authorizer: is_authorized_resource_request
        if not target_entity:
            err_msg = f"Invalid url path, Target entity not found:{request_info.parent_entity}"
            service_log.highlighted_error(err_msg)
            raise HTTPException(status_code=400, detail=err_msg)

        # Canonical parent pointer (supersedes the legacy per-type
        # ``data.parent_id``). Set before ``add_child`` so it persists with the
        # entity row + metadata — ``add_child`` saves the child first.
        if "parent_type_id" in type(entity).model_fields:
            entity.parent_type_id = str(target_entity.typeid)
        await target_entity.add_child(entity)

        # Auto-share: when the parent is reachable on the hub, the child must
        # become a hub ``is_child`` too so it syncs to watchers via ``child_*``.
        # The hub may not host the immediate parent's type (e.g. ``markdown``),
        # so we create the child under the nearest ancestor that has its OWN hub
        # row (the conversation). The child keeps ``parent_type_id`` = the real
        # local parent (the doc) in its payload for gutter filtering. Non-fatal.
        try:
            # One walk: the nearest ancestor with a hub row (or None) — being
            # non-None is exactly "effective_remote".
            hub_parent = await target_entity.nearest_remote_ancestor()
            if hub_parent is not None:
                await hub_parent.create_child(entity)
                if getattr(entity, "remote", False):
                    await entity.save(someone_typeid)
        except Exception as e:  # noqa: BLE001
            service_log.warn(
                f"[create] auto-share child {entity.typeid} under {target_entity.typeid} failed (non-fatal): {e}"
            )
    return entity
