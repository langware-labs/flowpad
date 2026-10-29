"""Rate-limited hub HTTP error reporting over the local WebSocket."""

from __future__ import annotations

import time
from collections import deque
from collections.abc import Awaitable, Callable
from typing import Any

from flow_sdk.api.messages import HubClientErrorMessage, HubClientRecoveredMessage
from flow_sdk.cloud_client.constants import MAX_HUB_ERRORS_PER_WINDOW, WINDOW_SECONDS

BroadcastFunc = Callable[[HubClientErrorMessage | HubClientRecoveredMessage], Awaitable[None]]
ClockFunc = Callable[[], float]

MAX_HIDDEN_KEPT = 20


def _log_file() -> str:
    """The backend log this error is written to, so its details can point at the line."""
    from flow_sdk import service_log  # noqa: PLC0415 — keeps this module import-light

    return str(service_log._log_file or "")


async def _broadcast_message(message: HubClientErrorMessage | HubClientRecoveredMessage) -> None:
    try:
        from flow_sdk.server.routes.websocket import broadcast

        await broadcast(message.model_dump_json())
    except Exception:
        pass


class _HubErrorReporter:
    def __init__(
        self,
        *,
        max_per_window: int = MAX_HUB_ERRORS_PER_WINDOW,
        window_seconds: float = WINDOW_SECONDS,
        clock: ClockFunc = time.monotonic,
        wall_clock: ClockFunc = time.time,
        broadcast_func: BroadcastFunc = _broadcast_message,
    ):
        self.max_per_window = max_per_window
        self.window_seconds = window_seconds
        self.clock = clock
        self.wall_clock = wall_clock
        self.broadcast_func = broadcast_func
        self._timestamps: deque[float] = deque()
        self._suppressed_in_window = 0
        # Requests whose last attempt failed, so the hub's next answer to one can clear its error.
        self._failing: set[tuple[str, str]] = set()
        # Repeats of one failing call: when it first failed and how often, until it recovers.
        self._groups: dict[tuple[str, str, int], dict[str, Any]] = {}
        # The errors a full window hid, sent with the next 'suppressed' notice (capped).
        self._hidden: list[dict[str, Any]] = []

    def _prune(self, now: float) -> None:
        cutoff = now - self.window_seconds
        while self._timestamps and self._timestamps[0] <= cutoff:
            self._timestamps.popleft()

    async def report(
        self,
        *,
        status_code: int,
        method: str,
        path: str,
        message: str,
        body: str = "",
        error_code: str = "",
        request_id: str = "",
        url: str = "",
        caller: str = "",
    ) -> None:
        self._failing.add((method, path))
        now = self.clock()
        wall = self.wall_clock()
        group = self._groups.setdefault((method, path, status_code), {"first_at": wall, "count": 0})
        group["count"] += 1
        error = {
            "status_code": status_code,
            "method": method,
            "path": path,
            "message": message,
            "body": body,
            "error_code": error_code,
            "request_id": request_id,
            "url": url,
            "caller": caller,
            "first_at": group["first_at"],
            "last_at": wall,
            "count": group["count"],
            "log_file": _log_file(),
        }
        self._prune(now)

        if len(self._timestamps) >= self.max_per_window:
            self._suppressed_in_window += 1
            if len(self._hidden) < MAX_HIDDEN_KEPT:
                self._hidden.append(error)
            return

        if self._suppressed_in_window:
            suppressed = self._suppressed_in_window
            hidden, self._hidden = self._hidden, []
            self._suppressed_in_window = 0
            await self.broadcast_func(
                HubClientErrorMessage(
                    status_code=status_code,
                    method=method,
                    path=path,
                    message=f"{suppressed} hub errors suppressed in last window",
                    suppressed_count=suppressed,
                    hidden=hidden,
                )
            )

        await self.broadcast_func(HubClientErrorMessage(**error))
        self._timestamps.append(now)

    async def recovered(self, *, method: str, path: str) -> None:
        """The hub answered a request whose previous attempt failed: say its error is over.

        Only a request that failed and then got an answer clears anything -- one that never got an
        answer keeps its error up, however long ago it was raised.
        """
        if (method, path) not in self._failing:
            return
        self._failing.discard((method, path))
        for key in [k for k in self._groups if k[:2] == (method, path)]:
            del self._groups[key]
        await self.broadcast_func(HubClientRecoveredMessage(method=method, path=path))


hub_error_reporter = _HubErrorReporter()
