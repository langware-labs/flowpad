"""Rate-limited hub HTTP error reporting over the local WebSocket."""

from __future__ import annotations

import time
from collections import deque
from collections.abc import Awaitable, Callable
from functools import lru_cache
from typing import Any

from flow_sdk.api.messages import HubClientErrorMessage, HubClientRecoveredMessage
from flow_sdk.cloud_client.constants import MAX_HUB_ERRORS_PER_WINDOW, WINDOW_SECONDS

BroadcastFunc = Callable[[HubClientErrorMessage | HubClientRecoveredMessage], Awaitable[None]]
ClockFunc = Callable[[], float]

MAX_HIDDEN_KEPT = 20
# Failing calls whose repeats are counted; the oldest is forgotten past this (a call with a unique
# query each time must not grow the map without bound).
MAX_GROUPS = 200


@lru_cache(maxsize=1)
def _log_file() -> str:
    """The backend log this error is written to, so its details can point at it."""
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
        # Repeats of one failing call, per status: (first failed at, times), until it recovers.
        self._groups: dict[tuple[str, str], dict[int, tuple[float, int]]] = {}
        # The errors a full window hid, sent with the next 'suppressed' notice (capped).
        self._hidden: list[dict[str, Any]] = []

    @property
    def has_failing(self) -> bool:
        return bool(self._failing)

    def _prune(self, now: float) -> None:
        cutoff = now - self.window_seconds
        while self._timestamps and self._timestamps[0] <= cutoff:
            self._timestamps.popleft()

    async def report(
        self, *, status_code: int, method: str, path: str, message: str, detail: dict[str, Any] | None = None
    ) -> None:
        """Report one failed hub call. ``detail`` is its ``ErrorDetail`` (the UI's details popup shape);
        when it first failed, how often, and the log file are added here."""
        self._failing.add((method, path))
        now = self.clock()
        wall_ms = self.wall_clock() * 1000
        first_ms, count = self._groups.setdefault((method, path), {}).get(status_code, (wall_ms, 0))
        self._groups[(method, path)][status_code] = (first_ms, count + 1)
        if len(self._groups) > MAX_GROUPS:
            del self._groups[next(iter(self._groups))]
        self._prune(now)

        def full_detail() -> dict[str, Any]:
            return {
                **(detail or {}),
                "firstAt": first_ms,
                "lastAt": wall_ms,
                "count": count + 1,
                "logFile": _log_file(),
            }

        if len(self._timestamps) >= self.max_per_window:
            self._suppressed_in_window += 1
            if len(self._hidden) < MAX_HIDDEN_KEPT:
                self._hidden.append({"title": f"{method} {path}", "detail": full_detail()})
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
                    detail={"hidden": hidden},
                )
            )

        await self.broadcast_func(
            HubClientErrorMessage(
                status_code=status_code, method=method, path=path, message=message, detail=full_detail()
            )
        )
        self._timestamps.append(now)

    async def recovered(self, *, method: str, path: str) -> None:
        """The hub answered a request whose previous attempt failed: say its error is over.

        Only a request that failed and then got an answer clears anything -- one that never got an
        answer keeps its error up, however long ago it was raised.
        """
        if (method, path) not in self._failing:
            return
        self._failing.discard((method, path))
        self._groups.pop((method, path), None)
        await self.broadcast_func(HubClientRecoveredMessage(method=method, path=path))


hub_error_reporter = _HubErrorReporter()
