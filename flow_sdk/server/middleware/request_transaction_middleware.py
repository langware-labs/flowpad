"""Middleware for setting up request context in minihub."""

import logging
from contextvars import copy_context

from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from flow_sdk.request_context.execution_context import (
    ExecutionContext,
    get_execution_context,
    set_execution_context,
)


# Per-process cache for the @local user. The local user is created once at
# server startup (get_or_create_local_user) and never mutated by app code,
# so we resolve it once and skip the per-request BEGIN IMMEDIATE that was
# racing the indexer's writer lock and producing 500s on the request.
_LOCAL_USER_CACHE = None


async def _get_local_user_cached():
    global _LOCAL_USER_CACHE
    if _LOCAL_USER_CACHE is not None:
        return _LOCAL_USER_CACHE
    from flow_sdk.builtin.user import User
    try:
        from flow_sdk.server.routes.bootstrap import get_or_create_local_user
        user = await get_or_create_local_user()
    except Exception:
        user = await User.get_one({"uname": "local"})
    if user is not None:
        _LOCAL_USER_CACHE = user
    return user


class RequestTransactionMiddleware:
    """Pure ASGI middleware that sets up ExecutionContext for each request.

    Using pure ASGI middleware instead of BaseHTTPMiddleware to ensure
    context variables are properly propagated through the request lifecycle.
    """

    def __init__(self, app: ASGIApp):
        self.app = app

    async def _setup_local_auth(self, req_info) -> Response | None:
        """Set up auth for local minihub - allow all requests for the @local user."""
        from flow_sdk.request_context.auth_info import AuthResult
        from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415
        from flow_sdk.responses.response import ApiFailResponse

        # Get or set the local user from the per-process cache (see
        # _get_local_user_cached above). This skips a BEGIN IMMEDIATE per
        # request that was racing the indexer's writer lock.
        if not req_info.user:
            local_user = await _get_local_user_cached()
            if local_user:
                req_info.user = local_user

        # Load the target entity if specified
        target_entity = None
        if req_info.target_entity_typeid and req_info.target_entity_typeid.id:
            try:
                entity_model = SchemaRegistry.get_entity_cls(req_info.target_entity_typeid.type)
                if entity_model is None:
                    logging.warning(
                        f"[Middleware] No entity_model registered for type={req_info.target_entity_typeid.type!r} "
                        f"(target id={req_info.target_entity_typeid.id})"
                    )
                else:
                    target_entity = await entity_model.get_by_typeid(req_info.target_entity_typeid)
                    if target_entity is None:
                        # TODO - this is a patch, remove it
                        # ``open`` deep-link actions can land on entities the
                        # local DB hasn't synced yet — a fresh invitee clicking
                        # the email link is the typical case. The handler
                        # (e.g. ``handle_open_flow_message``) fetches from the
                        # hub itself, so let it through with target_entity=None.
                        if req_info.action == "open":
                            logging.debug(
                                "[Middleware] open action on missing local entity "
                                f"{req_info.target_entity_typeid.type}/"
                                f"{req_info.target_entity_typeid.id} — letting handler "
                                "fetch from hub"
                            )
                        else:
                            message = (
                                f"Entity not found: {req_info.target_entity_typeid.type}/"
                                f"{req_info.target_entity_typeid.id}"
                            )
                            logging.debug("[Middleware] %s", message)
                            return JSONResponse(
                                content=ApiFailResponse(message=message, status_code=404).model_dump(mode="json"),
                                status_code=404,
                            )
            except Exception as e:
                logging.warning(
                    f"[Middleware] Failed to load target entity "
                    f"type={req_info.target_entity_typeid.type!r} id={req_info.target_entity_typeid.id}: {e!r}"
                )

        # Set auth result - allow all local requests
        req_info.auth_result = AuthResult(
            allowed=True,
            reason="local",
            target=target_entity,
            target_roles=["owner"],
            target_allowed_actions=["*"],
        )

        # Set su (superuser) flag for local requests - bypasses policy checks
        req_info.su = True

        # Set up minimal policies (required even for su mode)
        from flow_sdk.core.policy import PolicyResolver
        req_info.policies = PolicyResolver()
        return None

    async def __call__(self, scope: Scope, receive: Receive, send: Send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        # Create a proper Request object for parsing
        request = Request(scope, receive, send)
        logging.debug(f"[Middleware] Received request: {request.method} {request.url.path}")

        # Per-request transaction binding intentionally NOT wired.
        #
        # Wiring `transaction_factory = get_db_driver().get_transaction_factory()`
        # creates an AsyncSession per request via `factory()` (no async
        # context manager), then closes it in middleware finally. Under
        # the test scaffolding this leaks one aiosqlite connection per
        # ~30 standalone-session ops triggered by session-start fixtures,
        # holding the SQLite writer lock and breaking subsequent tests.
        # Root cause traces to SQLAlchemy issue #8145 — async connection
        # close requires async I/O which can't reliably run during
        # cancellation or non-context-managed teardown paths.
        #
        # Driver methods open their own short-lived sessions via
        # `_session_ctx` (always async-with managed → safe). The indexer
        # hoists ONE shared session for batch paths via `flow_sdk.db.session()`.
        # Production writer-lock-cascade fix (WAL + busy_timeout=15000 +
        # BEGIN IMMEDIATE + pragmas + driver session sharing) lands fully.
        execution_context = ExecutionContext(False, None)
        set_execution_context(execution_context)

        # Setup request info from the request (also opens the per-request session).
        try:
            await execution_context.setup(request=request, context_name="Request")
        except Exception as e:
            # Silently continue — dedicated routes (bootstrap, health, etc.) don't need
            # request_info parsing. The graph catch-all handler will raise its own error
            # when request_info is missing for actual graph paths.
            logging.debug(f"[Middleware] Skipping request parsing: {e}")

        # Log the request info that was set up
        from flow_sdk.request_context import get_current_request_info
        req_info = get_current_request_info()
        if req_info:
            logging.debug(f"[Middleware] RequestInfo: action={req_info.action}, resource={req_info.resource_type}, target={req_info.target_entity_typeid}")

            # For local minihub, set up auth to allow all requests
            early_response = await self._setup_local_auth(req_info)
        else:
            logging.debug("[Middleware] No RequestInfo set up")
            early_response = None

        try:
            async with execution_context.transaction_scope():
                if early_response is not None:
                    await early_response(scope, receive, send)
                else:
                    await self.app(scope, receive, send)
        finally:
            set_execution_context(None)
