"""Rate-limited hub HTTP error reporting over the local WebSocket."""

from __future__ import annotations

import time
from collections import deque
from collections.abc import Awaitable, Callable

from flow_sdk.api.messages import HubClientErrorMessage
from flow_sdk.cloud_client.constants import MAX_HUB_ERRORS_PER_WINDOW, WINDOW_SECONDS

BroadcastFunc = Callable[[HubClientErrorMessage], Awaitable[None]]
ClockFunc = Callable[[], float]


async def _broadcast_message(message: HubClientErrorMessage) -> None:
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
        broadcast_func: BroadcastFunc = _broadcast_message,
    ):
        self.max_per_window = max_per_window
        self.window_seconds = window_seconds
        self.clock = clock
        self.broadcast_func = broadcast_func
        self._timestamps: deque[float] = deque()
        self._suppressed_in_window = 0

    def _prune(self, now: float) -> None:
        cutoff = now - self.window_seconds
        while self._timestamps and self._timestamps[0] <= cutoff:
            self._timestamps.popleft()

    async def report(self, *, status_code: int, method: str, path: str, message: str) -> None:
        now = self.clock()
        self._prune(now)

        if len(self._timestamps) >= self.max_per_window:
            self._suppressed_in_window += 1
            return

        if self._suppressed_in_window:
            suppressed = self._suppressed_in_window
            self._suppressed_in_window = 0
            await self.broadcast_func(HubClientErrorMessage(
                status_code=status_code,
                method=method,
                path=path,
                message=f"{suppressed} hub errors suppressed in last window",
                suppressed_count=suppressed,
            ))

        await self.broadcast_func(HubClientErrorMessage(
            status_code=status_code,
            method=method,
            path=path,
            message=message,
        ))
        self._timestamps.append(now)


hub_error_reporter = _HubErrorReporter()
