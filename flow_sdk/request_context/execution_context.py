"""Execution context for request handling in minihub."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from contextvars import ContextVar, Token
from typing import TYPE_CHECKING, Any, Callable, Optional

from starlette.requests import Request

from .request_info import RequestInfo

if TYPE_CHECKING:
    pass


class ExecutionContext:
    def __init__(self, immediate_commit: bool = False, transaction_factory: Callable[[], Any] | None = None):
        self.transaction_factory: Callable[[], Any] | None = transaction_factory
        self.request_info_var_token: Token | None = None
        self.request_info: RequestInfo | None = None
        self.prev_context_token: Token | None = None
        self.context_name: str | None = "unknown"
        self.immediate_commit = immediate_commit
        self.connection_id: str | None = None
        self.message_request_id: str | None = None
        self.service: Any | None = None

    async def setup(
        self,
        request: Optional[Request] = None,
        api_path: str = "",
        action: Optional[str] = None,
        user: Any = None,
        context_name: str | None = None,
        connection_id: str | None = None,
        message_request_id: str | None = None,
    ):
        self.context_name = context_name
        self.connection_id = connection_id
        request_info_initialized = RequestInfo()
        request_info_initialized.immediate_commit = self.immediate_commit
        if request:
            request_info_initialized.request = request
            await request_info_initialized.parse_from_request(request)
        else:
            await request_info_initialized.parse_api_path(api_path)
        if user:
            request_info_initialized.user = user
        if action:
            request_info_initialized.action = action
        if connection_id:
            request_info_initialized.request_connection_id = connection_id
        if message_request_id:
            request_info_initialized.request_message_id = message_request_id
        self.request_info = request_info_initialized

        if self.transaction_factory:
            handler = self.transaction_factory()
            request_info_initialized.transaction_handler = handler
            await handler.start()

    async def cleanup(self):
        """Close the transaction. Idempotent and safe after commit/rollback.

        cleanup() is the finally-block teardown and never decides durability.
        Callers are expected to invoke commit_transaction() on the success
        path or rollback_transaction() on the exception path BEFORE cleanup.
        """
        if self.request_info and self.request_info.transaction_handler:
            await self.request_info.transaction_handler.close()

    async def commit_transaction(self):
        """Commit the request-scoped transaction.

        Called on the success path of a request handler so writes durably
        persist before the session is closed in cleanup().
        """
        if self.request_info and self.request_info.transaction_handler:
            handler = self.request_info.transaction_handler
            commit = getattr(handler, "commit", None)
            if commit is not None:
                await commit()

    async def rollback_transaction(self):
        logging.info(f"{self.context_name}-> context rollback")
        if self.request_info and self.request_info.transaction_handler:
            await self.request_info.transaction_handler.rollback()

    @asynccontextmanager
    async def transaction_scope(self):
        """The request transaction boundary — single source of truth for durability.

        Wrap a request handler in ``async with ec.transaction_scope()``: the
        body's writes are committed on success, rolled back on exception
        (then the exception is re-raised), and the session is always closed
        via cleanup(). Both entry paths use this — RequestTransactionMiddleware
        for HTTP and handle_rest_message for WebSocket rest messages — so the
        commit/rollback/cleanup rule is written exactly once. The WS path
        bypasses ASGI middleware entirely, so without this shared scope it
        would otherwise need its own divergent copy of the rule.
        """
        try:
            yield self
        except Exception:
            await self.rollback_transaction()
            raise
        else:
            await self.commit_transaction()
        finally:
            await self.cleanup()

    @classmethod
    @asynccontextmanager
    async def create(
        cls,
        *,  # Force keyword arguments for clarity
        user: Any = None,
        request: Optional[Request] = None,
        api_path: str = "",
        action: Optional[str] = None,
        context_name: str | None = None,
        connection_id: str | None = None,
        immediate_commit: bool = False,
        transaction_factory: Callable[[], Any] | None = None,
    ):
        context = cls(immediate_commit=immediate_commit, transaction_factory=transaction_factory)
        set_execution_context(context)
        try:
            await context.setup(
                request=request,
                api_path=api_path,
                action=action,
                user=user,
                context_name=context_name,
                connection_id=connection_id,
            )
            yield context
        finally:
            await context.cleanup()


execution_context_var: ContextVar[ExecutionContext] = ContextVar("execution_context_var", default=None)


def set_execution_context(execution_context: ExecutionContext | None):
    execution_context_var.set(execution_context)


def get_execution_context() -> Optional[ExecutionContext]:
    context = execution_context_var.get(None)
    return context
