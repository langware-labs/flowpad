import logging
from typing import Any, Awaitable, Callable, List, Optional


class TransactionHandler:
    def __init__(self):
        self.db_transaction: Any = None
        self.db_session: Any = None
        # close transaction is a function pointer to close the session
        self._start_transaction: Optional[Callable[["TransactionHandler"], Awaitable[None]]] = None
        self._close_transaction: Optional[Callable[["TransactionHandler"], Awaitable[None]]] = None
        self._rollback_transaction: Optional[Callable[["TransactionHandler"], Awaitable[None]]] = None
        # list of notification functions to be called when the transaction is closed
        self._transaction_notifications: List[Callable[[], None]] = []

    def set_start_method(self, start_transaction: Callable):
        self._start_transaction = start_transaction

    def set_close_method(self, close_transaction: Callable[[Any], Awaitable[None]]):
        self._close_transaction = close_transaction

    def set_rollback_method(self, rollback_transaction: Callable[[Any], Awaitable[None]]):
        self._rollback_transaction = rollback_transaction

    async def start(self):
        if self._start_transaction:
            self.db_transaction = await self._start_transaction(self)
        else:
            raise Exception("No start_transaction function to start the transaction")

    async def close(self):
        if self._close_transaction:
            await self._close_transaction(self)
        else:
            raise Exception("No close_transaction function to close the transaction")
        await self._notify_transaction_pending_notifications()

    async def rollback(self):
        if self._rollback_transaction:
            await self._rollback_transaction(self)
        else:
            logging.warning("No rollback_transaction function to rollback the transaction")

    def add_notification_to_transaction(self, notification: Callable[[], None]):
        self._transaction_notifications.append(notification)

    async def _notify_transaction_pending_notifications(self):
        while self._transaction_notifications:
            notification = self._transaction_notifications.pop()
            notification()
