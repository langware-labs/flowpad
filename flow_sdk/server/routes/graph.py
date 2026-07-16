import asyncio
import inspect
import logging
from json import JSONDecodeError
from typing import Any, Tuple, Type, get_args, get_origin

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from pydantic import BaseModel, ValidationError
from sse_starlette import EventSourceResponse
from starlette.responses import Response, StreamingResponse
from starlette.websockets import WebSocketDisconnect

from flow_sdk import service_log
from flow_sdk.actions import action
from flow_sdk.api.type_id import TypeId
from flow_sdk.builtin.user import User, normalize_email
from flow_sdk.core.auth.custom import local_signin
from flow_sdk.core.auth.models import SignupInfo
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.db.drivers.db_driver import DBResetProfile, get_db_driver
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.request_context.methods import get_current_request_info, get_current_service_config
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse

graph_router = APIRouter()


async def handle_reset_action(request: Request):
    request_info = get_current_request_info()
    if request_info is None:
        raise HTTPException(status_code=570, detail="Invalid request")
    method = request.method
    try:
        data = await request_info.get_post_data()
    except JSONDecodeError:
        data = {}
    soft_reset = data.get("soft", False)
    if data.get("message"):
        logging.info(f"Reset action: {data.pop('message')}, soft: {soft_reset}")
    local_signup_info: SignupInfo = local_signin.get_local_signup()
    user: User | None = request_info.user
    if user is None:
        raise HTTPException(status_code=571, detail="Server Error")
    if normalize_email(user.email) != normalize_email(local_signup_info.email):
        raise HTTPException(status_code=572, detail="Server Error")
    if user.name != local_signup_info.name:
        raise HTTPException(status_code=573, detail="Server Error")
    if request.base_url.hostname != "localhost" and request.base_url.hostname != "testserver":
        raise HTTPException(status_code=574, detail="Server Error")
    if method != "POST":
        raise HTTPException(status_code=575, detail="Invalid request")
    dev_machine = get_current_service_config().development
    if not dev_machine:
        raise HTTPException(status_code=576, detail="Server Error")
    if soft_reset:
        db_reset_profile = DBResetProfile.soft_reset_profile()
        db_reset_profile.add_instance(user.typeid)
    else:
        db_reset_profile = DBResetProfile.model_validate(data)
    instances_to_keep = data.get("instances_to_keep", [])
    for instance in instances_to_keep:
        db_reset_profile.add_instance(TypeId(**instance))
    db_reset_profile.create_builtin_instances = data.get("create_builtin_instances", False)
    db_reset_profile.load_entities_indexes = data.get("load_entities_indexes", False)
    db_driver = get_db_driver()
    await db_driver.clean_all_db(db_reset_profile)
    # Clear caches after database reset to prevent stale entities and auth results
    from flow_sdk.core.auth.auth_cache import get_auth_cache
    from flow_sdk.core.cache.entity_cache import entity_cache, uname_cache

    entity_cache.clear()
    uname_cache.clear()
    get_auth_cache().clear()
    return ApiSuccessResponse[bool](data=True)


def get_base_model_type(annotation):
    """Extract BaseModel type from annotation, handling Optional types"""
    # Handle Optional[SomeType] -> SomeType
    origin = get_origin(annotation)
    if origin is not None:
        # For Optional[T], get_origin returns Union and get_args returns (T, NoneType)
        args = get_args(annotation)
        if len(args) == 2 and type(None) in args:
            # This is Optional[T], get the non-None type
            non_none_type = next(arg for arg in args if arg is not type(None))
            return get_base_model_type(non_none_type)

    # Check if it's a BaseModel type
    if isinstance(annotation, type) and issubclass(annotation, BaseModel):
        return annotation

    return None


def get_entity_model_from_registry(entity_type: str):
    entity_model: Type[Entity] | None = SchemaRegistry.get_entity_cls(entity_type)
    if not entity_model:
        raise HTTPException(status_code=400, detail=f"Graph error: Unknown entity type: {entity_type}")
    return entity_model


async def get_by_id(target: TypeId) -> Tuple[Type[Entity], Entity]:
    request_info = get_current_request_info()
    if not request_info or not request_info.auth_result:
        raise HTTPException(status_code=400, detail="Invalid request")
    if target.id is None:
        raise HTTPException(status_code=400, detail="missing entity id")
    entity_model = get_entity_model_from_registry(target.type)
    entity = request_info.auth_result.target
    if not entity:
        service_log.highlighted_error(f"Entity not in context during get by id: {target.type}(id:{target.id})")
        raise HTTPException(
            status_code=404,
            detail=f"Entity not found, Get failed: {target.type}(id:{target.id})",
        )

    expansion_tasks = []
    if request_info.expand_permissions:
        expansion_tasks.append(entity.expand_permissions())
    if request_info.expand_auth_scopes:
        expansion_tasks.append(entity.expand_auth_scopes())
    # TODO, make get one, get by id, epxand, get all etc. consolidate expansion and storage logic
    if request_info.expand_blobs:
        expansion_tasks.append(entity.expand_blobs())
    if expansion_tasks:
        await asyncio.gather(*expansion_tasks)
    return entity_model, entity


async def handle_request(
    request: Request, response: Response | None = None, background_tasks: BackgroundTasks | None = None
) -> ApiResponse | Response:
    import time as _bench_time
    _hr_t0 = _bench_time.perf_counter()
    def _hr_bench(label):
        try:
            with open("/tmp/bench_open.log", "a") as _f:
                _f.write(f"[BENCH handle_request {request.url.path[-30:]}] {label}: {(_bench_time.perf_counter() - _hr_t0) * 1000:.1f}ms\n")
        except Exception:
            pass
    _hr_bench("entry")
    request_info = get_current_request_info()
    if not request_info:
        service_log.warn("Request info not found in handle_request")
        raise HTTPException(status_code=400, detail="Invalid request")
    if request_info.action is None:
        service_log.warn("Action not found in request info")
        raise HTTPException(status_code=400, detail="Missing action")
    if request_info.action.lower() == "resetAvailableOnlyForLocalUserOnTesting".lower():
        return await handle_reset_action(request)

    a = action.get_by_name(request_info.action, request_info.resource_type)
    if not a:
        raise HTTPException(status_code=400, detail=f"Unknown action: {request_info.action}")
    if not a.handler:
        service_log.warn(f"Action handler not found for action: {request_info.action}")
        raise HTTPException(
            status_code=400,
            detail=f"Action handler not found: {request_info.action}",
        )

    _hr_bench("after action lookup")
    sig = inspect.signature(a.handler)
    params = sig.parameters
    kwargs = {}

    # Fill the first parameter (self or cls)
    first_param = list(params.values())[0] if params else None
    if first_param:
        await fill_self_cls_param_if_needed(kwargs, first_param, request_info)
    _hr_bench("after fill_self_cls_param")

    request_params = request_info.request_parameters

    # Read JSON body once to avoid consuming it multiple times
    json_data = {}
    try:
        json_data = await request_info.get_post_data()
    except JSONDecodeError:
        pass

    for name, param in params.items():
        if name in kwargs:
            continue  # Skip if already handled (self or cls)
        if param.annotation is not param.empty:
            # First, try to handle by annotation
            if param.annotation is Request:
                kwargs[name] = request
                continue
            elif param.annotation is Response:
                kwargs[name] = response
                continue
            elif param.annotation is BackgroundTasks:
                kwargs[name] = background_tasks
                continue
            else:
                # Check if it's a BaseModel type (including Optional[BaseModel])
                base_model_type = get_base_model_type(param.annotation)
                if base_model_type:
                    try:
                        # Use the already-read JSON data
                        data = json_data.copy()
                        data.update(request_params)
                        kwargs[name] = base_model_type.model_validate(data)
                        continue
                    except ValidationError as e:
                        service_log.warn(
                            f"Validation error for {name} in action: {request_info.action} with schema: {base_model_type.model_json_schema()}, error: {e}"
                        )
                        raise HTTPException(
                            status_code=400,
                            detail=f"Invalid JSON data for {name}, with schema: {base_model_type.model_json_schema()}, error: {e}",
                        )
        else:
            # If no annotation, try to handle by name
            if name == "request":
                kwargs[name] = request
                continue
            elif name == "background_tasks":
                kwargs[name] = background_tasks
                continue
        if name in request_params.keys():
            kwargs[name] = request_params[name]
        else:
            # Also try to get from JSON body
            if name in json_data:
                kwargs[name] = json_data[name]

    # Check if all required arguments are present
    required_params = {name: param for name, param in params.items() if param.default is param.empty}
    missing_params = set(required_params.keys()) - set(kwargs.keys())
    if missing_params:
        # Try filling missing params from request body
        for name in missing_params:
            if name in json_data:
                kwargs[name] = json_data[name]
            else:
                service_log.warn(f"Missing required argument: {name} in action: {request_info.action}")
                raise HTTPException(
                    status_code=400,
                    detail=f"Missing required argument: {name}",
                )
        other_params = set(params.keys()) - set(kwargs.keys())
        for name in other_params:
            if name in json_data:
                kwargs[name] = json_data[name]

    _hr_bench("before handler call")

    # Hub reflection: if the call opts in (``request_info.hub_reflect``) and the
    # entity has a hub counterpart (remote=True), forward the call to the
    # hub and mirror its response into the local row instead of running
    # the local handler. Falls through to the local handler on HubError
    # (offline / hub unreachable) so degraded mode still works.
    from flow_sdk.server.routes._hub_reflect import (
        reflect_to_hub,
        should_reflect_to_hub,
    )
    from flow_sdk.utils.hub import HubError

    # The target entity for reflection: entity-bound action handlers receive it
    # as ``self`` (e.g. ``members``), but the generic CRUD handlers (``update`` /
    # ``create`` / ``delete``) take only ``request`` — for those, fall back to the
    # framework-resolved target so a reflectable PUT (e.g. a conversation rename)
    # still finds its entity.
    entity_for_reflect = kwargs.get("self")
    if entity_for_reflect is None and request_info.auth_result is not None:
        entity_for_reflect = request_info.auth_result.target
    if should_reflect_to_hub(entity_for_reflect, request_info.hub_reflect):
        try:
            # Carry the REAL request method into reflection — never infer the hub
            # verb from the matched action's static methods (see reflect_to_hub).
            hub_data = await reflect_to_hub(
                a,
                entity_for_reflect,
                {**request_params, **json_data},
                request_info.method,
                request_info.sub_path,
            )
            _hr_bench("after hub reflect")
            return ApiResponse.success(data=hub_data)
        except HubError as e:
            # A hub REJECTION (4xx/5xx) of a mutation must reach the client —
            # falling back to the local handler would turn a denial (e.g. the
            # members role-change/remove 403 from the hub's authorization
            # gates) into a silent fake success and drift local state from the
            # hub. Only transport failures (status_code == 0: DNS, refused,
            # timeout — i.e. offline) keep the degraded local fallback, and
            # GETs always do (a stale local read beats an error).
            if request_info.method.upper() != "GET" and e.status_code >= 400:
                raise HTTPException(status_code=e.status_code, detail=e.reason)
            service_log.warn(
                f"[hub-reflect] {request_info.action} on {entity_for_reflect.type}/{entity_for_reflect.id} "
                f"falling back to local: {e}"
            )
        except Exception as e:  # noqa: BLE001
            # Never let a reflection-layer bug 500 the whole request — fall
            # through to the local handler. The dispatcher is opportunistic.
            service_log.warn(
                f"[hub-reflect] unexpected error on {request_info.action} "
                f"for {entity_for_reflect.type}/{entity_for_reflect.id}: {type(e).__name__}: {e}"
            )

    # Call the function with the matched arguments
    try:
        if inspect.iscoroutinefunction(a.handler):
            response = await a.handler(**kwargs)
        else:
            response = a.handler(**kwargs)
    except Exception as e:
        service_log.error(f"Action failed: {request_info.action}, {e}")
        raise e
    _hr_bench("after handler call")

    if isinstance(response, Response):
        return response
    if isinstance(response, EventSourceResponse):
        return response
    if isinstance(response, (RedirectResponse, HTMLResponse)):
        return response
    if isinstance(response, StreamingResponse):
        return response
    if not isinstance(response, ApiResponse):
        err_msg = f"Action failed: {request_info.action}, invalid response: {response}"
        service_log.warn(err_msg)
        raise HTTPException(
            status_code=580,
            detail=err_msg,
        )
    # ApiFailResponse is a legitimate response -- return it directly with its
    # status_code so the caller gets proper ApiResponse JSON instead of a raw
    # HTTPException detail string.  The old code raised HTTPException here,
    # which lost the structured response format.
    if not isinstance(response, ApiSuccessResponse):
        if getattr(response, "status_code", None) != 404:
            service_log.warn(f"Action returned non-success: {request_info.action}, message: {response.message}")

    _hr_bench("before return (response built)")
    return response


_SELF_HEAL_INDEXERS: dict[str, Any] | None = None


def _get_self_heal_indexers() -> dict[str, Any]:
    """Per-type single-file indexers used by the 404 self-heal path. Built
    lazily so import cost only lands when an actual self-heal happens.

    v1 wires PLAN only (the original RCA target). Other file-backed types
    (markdown, claude_md, claude_command, skill, claude_memory, claude_rules)
    can be added when the chip→loader→hint_path wiring on the FE starts
    sending hints for them.
    """
    global _SELF_HEAL_INDEXERS
    if _SELF_HEAL_INDEXERS is not None:
        return _SELF_HEAL_INDEXERS
    out: dict[str, Any] = {}
    try:
        from flow_sdk.fs_store.transcript_indexer.handlers.single_file_indexers import (
            _index_single_claude_md,
            _index_single_claude_memory,
            _index_single_claude_rules,
            _index_single_command,
            _index_single_markdown,
            _index_single_plan,
            _index_single_skill,
        )
        out["plan"] = _index_single_plan
        out["markdown"] = _index_single_markdown
        out["skill"] = _index_single_skill
        out["claude_md"] = _index_single_claude_md
        out["claude_memory"] = _index_single_claude_memory
        out["claude_rules"] = _index_single_claude_rules
        out["command"] = _index_single_command
    except Exception:
        pass
    _SELF_HEAL_INDEXERS = out
    return out


async def _try_self_heal_missing_entity(
    request: Request,
    request_info,
) -> Any | None:
    """If the GET 404'd and the caller passed ``?hint_path=<file>``, run a
    single-file index for the target type and retry the lookup. Returns the
    rehydrated entity on success, None otherwise.

    Per the no-auto-walk rule (feedback_no_auto_indexing.md), this only
    fires when the caller explicitly provided a path hint — chip clicks
    that originated from a context entry carrying ``data.path``.
    """
    target_typeid = request_info.target_entity_typeid
    if not target_typeid:
        return None
    hint_path = request.query_params.get("hint_path")
    if not hint_path:
        return None
    indexers = _get_self_heal_indexers()
    indexer = indexers.get(target_typeid.type)
    if indexer is None:
        return None
    from pathlib import Path
    p = Path(hint_path)
    if not p.exists():
        return None
    try:
        await indexer(p)
    except Exception as exc:
        service_log.warn(
            f"self-heal index failed for {target_typeid} at {hint_path}: {exc}"
        )
        return None
    # Reset the per-request cache so the retry actually rehydrates.
    request_info._target_entity = None
    if request_info.auth_result is not None:
        request_info.auth_result.target = None
    return await request_info.get_target_entity()


async def fill_self_cls_param_if_needed(args, first_param, request_info):
    # Check if we need to pass 'self' or 'cls'
    if first_param.name == "self":
        if not request_info.target_entity_typeid:
            raise HTTPException(
                status_code=400,
                detail="Action handler requires 'self' but no target entity found",
            )
        if not request_info.direct_resource_type:
            target_entity = await request_info.get_target_entity()
            if target_entity is None:
                # 404 self-heal: ?hint_path=<file> → single-file index + retry.
                target_entity = await _try_self_heal_missing_entity(
                    request_info.request, request_info
                )
            if target_entity is None:
                raise HTTPException(
                    status_code=404,
                    detail=f"Entity not found: {request_info.target_entity_typeid}",
                )
            args[first_param.name] = target_entity
        else:
            service_log.warn(
                f"Action handler requires 'self' but no instance is available: {request_info.direct_resource_type}"
            )
            args[first_param.name] = get_entity_model_from_registry(request_info.direct_resource_type)
    elif first_param.name == "cls":
        if not request_info.direct_resource_type:
            raise HTTPException(
                status_code=400,
                detail="Action handler requires 'cls' but no direct resource type found",
            )
        args[first_param.name] = get_entity_model_from_registry(request_info.direct_resource_type)


@graph_router.api_route(
    "/{path:path}",
    methods=["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD", "PATCH", "TRACE"],
)
async def catch_all(request: Request, response: Response, background_tasks: BackgroundTasks):
    """
    Catch all paths and HTTP methods and process them with this function.
    """
    try:
        request_info = get_current_request_info()
        if request_info is not None:
            result = await handle_request(request, response, background_tasks)
            # Set the HTTP status code from ApiFailResponse so callers see
            # a proper error code rather than 200 with a FAIL body.
            if isinstance(result, ApiResponse) and not isinstance(result, ApiSuccessResponse):
                status_code = getattr(result, "status_code", 500)
                response.status_code = status_code
            return result
        # request_info is None — the middleware failed to parse this path.
        # Re-parse to surface the specific error as an ApiResponse.
        from flow_sdk.api.api_request import APIRequest

        try:
            APIRequest.from_api_path(request.url.path)
        except HTTPException as exc:
            response.status_code = exc.status_code
            return ApiFailResponse[Any](message=exc.detail)
        except Exception:
            pass
        return ApiFailResponse[Any](message="Invalid request")
    except HTTPException as exc:
        response.status_code = exc.status_code
        return ApiFailResponse[Any](message=exc.detail)
    except WebSocketDisconnect:
        return None  # Handle WebSocket disconnections gracefully


# Note: To access body data, you may need to use different strategies based on the HTTP method,
# since GET and HEAD requests typically do not have a body.
# You might also need special handling for content types (e.g., JSON, form data).
# bench-trigger-1777147027
