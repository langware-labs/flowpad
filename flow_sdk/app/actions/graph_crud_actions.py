from json import JSONDecodeError

from fastapi import HTTPException, Request
from pydantic import ValidationError

from flow_sdk.flowpad_types.enums.auth_enums import AuthRole
from flow_sdk import service_log
from flow_sdk.builtin.user import User
from flow_sdk.builtin.visitor import Visitor
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.db.drivers.query import QueryFilter
from flow_sdk.actions import action
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiSuccessResponse, ApiFailResponse
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
    if isinstance(filter_params, dict) and _truthy(filter_params.get("include_system")):
        return True
    return False


async def handle_get_by_id():
    request_info = get_current_request_info()
    if not request_info:
        raise HTTPException(status_code=400, detail="invalid request info")
    if request_info.target_entity_typeid is None:
        raise HTTPException(status_code=400, detail="target not available")
    entity_model, entity = await get_by_id(request_info.target_entity_typeid)
    # Schedule background record refresh (non-blocking)
    if entity is not None and hasattr(entity, 'check_and_refresh_record'):
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
    if rec is None:
        # Try by uname as well
        if getattr(entity, "uname", None):
            from flow_sdk.fs_store.fs_record import FSRecord
            rec = FSRecord.load_or_none(entity.type, entity.uname)
    if rec is None:
        return ApiFailResponse(message="Record not found", status_code=404)

    type_id_str = str(request_info.target_entity_typeid)

    record_folder_ref_dict = rec.record_folder_ref.to_dict(type_id_str) if rec.record_folder_ref is not None else None
    main_ref_dict = rec.main_ref.to_dict(type_id_str) if rec.main_ref is not None else None

    return ApiSuccessResponse(data={"record_folder_ref": record_folder_ref_dict, "main_ref": main_ref_dict})


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

    # Get the entity model using the new helper function
    entity_model = get_entity_model_from_registry(request_info.direct_resource_type)
    try:
        sanitized_data = {}
        for key, value in data.items():
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
    if request_info.direct_resource_type == "agent" and not getattr(entity, "name", None):
        raise HTTPException(status_code=400, detail="Agent must have a name")

    someone_typeid = request_info.someone_typeid
    if not someone_typeid:
        raise HTTPException(status_code=400, detail="invalid auth result")

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

        await target_entity.add_child(entity)
    # TODO Turn off expand_permissions upon entity creation
    await entity.expand_permissions()

    return ApiSuccessResponse[Entity](data=entity)
