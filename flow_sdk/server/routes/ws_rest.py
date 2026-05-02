"""REST API message handling over WebSocket for minihub.

Handles rest_api_msg messages by routing them to the graph request handler.
"""

import json
import logging
import traceback

from starlette.requests import Request
from starlette.websockets import WebSocket

from flow_sdk.api.messages import APIMessage, WSMessageType
from flow_sdk.request_context.execution_context import ExecutionContext, set_execution_context
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.request_context.auth_info import AuthResult
from flow_sdk.responses.response import ApiResponse, ApiFailResponse

logger = logging.getLogger(__name__)


async def setup_rest_context(connection_id: str, message_json: dict) -> ExecutionContext:
    """Set up execution context for a REST API message over WebSocket."""
    api_message = APIMessage(**message_json)

    async def body_receive():
        json_body = json.dumps(api_message.body).encode("utf-8") if api_message.body else b"{}"
        return {
            "type": "http.request",
            "body": json_body,
            "more_body": False,
        }

    async def no_receive():
        return {
            "type": "http.request",
            "body": b"",
            "more_body": False,
        }

    receive = body_receive if api_message.body else no_receive

    request = Request(
        scope={
            "type": "http",
            "method": api_message.method or "GET",
            "path": api_message.api_path,
            "query_string": api_message.query_string.encode("utf-8") if api_message.query_string else b"",
            "headers": [(b"content-type", b"application/json")],
        },
        receive=receive,
    )

    execution_context = ExecutionContext(False, None)
    await execution_context.setup(
        api_path=api_message.api_path,
        action=api_message.action,
        request=request,
        connection_id=connection_id,
        message_request_id=api_message.message_id,
        context_name="WS_REST",
    )

    # Set up local auth (allow all for minihub)
    req_info = get_current_request_info()
    if req_info:
        from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415
        from flow_sdk.server.middleware.request_transaction_middleware import _get_local_user_cached

        # Get or set the local user from the per-process cache. Same hot path
        # as the HTTP middleware (see request_transaction_middleware.py).
        try:
            local_user = await _get_local_user_cached()
            if local_user:
                req_info.user = local_user
        except Exception as e:
            logger.debug(f"[WS_REST] Failed to get local user: {e}")

        # Load the target entity if specified
        target_entity = None
        if req_info.target_entity_typeid and req_info.target_entity_typeid.id:
            try:
                entity_model = SchemaRegistry.get_entity_cls(req_info.target_entity_typeid.type)
                if entity_model:
                    target_entity = await entity_model.get_by_typeid(req_info.target_entity_typeid)
            except Exception as e:
                logger.debug(f"[WS_REST] Failed to load target entity: {e}")

        # Set auth result - allow all local requests
        req_info.auth_result = AuthResult(
            allowed=True,
            reason="local",
            target=target_entity,
            target_roles=["owner"],
            target_allowed_actions=["*"],
        )
        req_info.su = True

        # Set up minimal policies
        from flow_sdk.core.policy import PolicyResolver
        req_info.policies = PolicyResolver()

    set_execution_context(execution_context)
    return execution_context


async def handle_rest_message(connection_id: str, websocket: WebSocket, message_json: dict):
    """Handle REST API message over WebSocket."""
    from flow_sdk.server.routes.graph import handle_request

    api_message = APIMessage(**message_json)
    response = None
    execution_context = None

    try:
        execution_context = await setup_rest_context(connection_id, message_json)
        req_info = get_current_request_info()
        if not req_info:
            raise RuntimeError("Request info not found")

        if not req_info.request:
            raise RuntimeError("Request not found")

        response = await handle_request(req_info.request)

    except Exception as ex:
        logger.error(f"Error handling REST message: {ex}")
        logger.debug(f"Exception stack: {traceback.format_exc()}")
        response = ApiFailResponse[str](status_code=403, message="Request error", data=str(ex))

    finally:
        if execution_context is not None:
            await execution_context.cleanup()

        if isinstance(response, ApiResponse):
            json_data = response.model_dump()

            # Check if data contains an already-wrapped response_msg (stream/pty path)
            nested_msg = None
            if json_data and "data" in json_data:
                data = json_data.get("data")
                if (
                    data
                    and isinstance(data, dict)
                    and "message_type" in data
                    and data["message_type"] == WSMessageType.RESPONSE_MSG.value
                ):
                    nested_msg = data

            if nested_msg is not None:
                await websocket.send_text(json.dumps(nested_msg))
            elif api_message.message_id:
                # Wrap as response_msg so the TS pending-request resolver can match by
                # response_message_id. The full ApiResponse payload goes into `content`
                # so callers can inspect status/message/data as usual.
                response_msg = {
                    "message_type": "response_msg",
                    "message_id": api_message.message_id,
                    "response_message_id": api_message.message_id,
                    "content": json_data,
                }
                await websocket.send_text(json.dumps(response_msg))
            else:
                await websocket.send_text(json.dumps(json_data))
        elif response is not None:
            # Handle non-ApiResponse types (e.g., plain dicts)
            response_msg = {
                "message_type": "response_msg",
                "response_message_id": api_message.message_id,
                "content": response if isinstance(response, dict) else str(response),
            }
            await websocket.send_text(json.dumps(response_msg))

    return response
