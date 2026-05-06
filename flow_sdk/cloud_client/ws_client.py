"""Outbound WebSocket client for authenticated hub communication."""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from contextlib import asynccontextmanager
from typing import Any, Literal
from urllib.parse import urlsplit, urlunsplit

import websockets
from websockets.exceptions import (
    ConnectionClosed,
    ConnectionClosedError,
    InvalidHandshake,
    InvalidStatus,
)

from flow_sdk.cli.auth.credentials import UserHubCredentials, load_credentials
from flow_sdk.cloud_client.auth_state import invalidate_hub_login
from flow_sdk.cloud_client.client import ApiConfig
from flow_sdk.cloud_client.constants import EXPIRY_LEEWAY_SECONDS


logger = logging.getLogger(__name__)

AUTH_WS_STATUS_CODES = {401, 403, 412, 424}
AUTH_WS_CLOSE_CODES = {1001, 1008}
HUB_WS_VERIFY_TIMEOUT_SECONDS = 10.0
HUB_WS_START_TIMEOUT_SECONDS = 5.0
HubWsStatus = Literal["disconnected", "connecting", "connected", "verified", "error"]


class HubWebSocketAuthError(RuntimeError):
    """Raised when the hub WebSocket cannot be used because auth is invalid."""


class HubWebSocketLoginRequiredError(HubWebSocketAuthError):
    """Raised when a hub WebSocket operation requires a cloud login."""


class HubWebSocketVerificationError(RuntimeError):
    """Raised when hub WebSocket verification fails without invalidating login."""


def build_hub_ws_url(api_base_url: str | None = None, connection_id: str | None = None) -> str:
    """Build the hub WebSocket URL from an API base URL."""
    base_url = api_base_url or ApiConfig.from_env().api_base_url
    if not base_url:
        raise ValueError("hub API base URL is not configured")

    parsed = urlsplit(base_url)
    if parsed.scheme == "http":
        scheme = "ws"
    elif parsed.scheme == "https":
        scheme = "wss"
    elif parsed.scheme in {"ws", "wss"}:
        scheme = parsed.scheme
    else:
        raise ValueError(f"unsupported hub URL scheme: {parsed.scheme}")

    path = f"{parsed.path.rstrip('/')}/connect/ws/{connection_id or uuid.uuid4()}"
    return urlunsplit((scheme, parsed.netloc, path, "", ""))


async def _load_ws_credentials() -> UserHubCredentials | None:
    creds = load_credentials()
    if not creds:
        raise HubWebSocketLoginRequiredError("Cloud login required before connecting hub WebSocket.")

    if creds.is_expired(EXPIRY_LEEWAY_SECONDS):
        await invalidate_hub_login("expired")
        raise HubWebSocketAuthError("hub auth expired")

    return creds


def _exception_status_code(exc: BaseException) -> int | None:
    status_code = getattr(exc, "status_code", None)
    if isinstance(status_code, int):
        return status_code

    response = getattr(exc, "response", None)
    response_status = getattr(response, "status_code", None)
    if isinstance(response_status, int):
        return response_status

    return None


async def _handle_ws_auth_exception(exc: BaseException) -> None:
    status_code = _exception_status_code(exc)
    if status_code in AUTH_WS_STATUS_CODES:
        await invalidate_hub_login("rejected")


@asynccontextmanager
async def connect_hub_websocket(
    config: ApiConfig | None = None,
    *,
    connection_id: str | None = None,
    open_timeout: float = 10.0,
):
    """Connect to the authenticated hub WebSocket with stored credentials."""
    creds = await _load_ws_credentials()

    api_base_url = (config or ApiConfig.from_env()).api_base_url
    url = build_hub_ws_url(api_base_url, connection_id)
    headers = {"Authorization": f"Bearer {creds.api_key}"}

    try:
        async with websockets.connect(
            url,
            additional_headers=headers,
            open_timeout=open_timeout,
            proxy=None,
        ) as websocket:
            yield websocket
    except (InvalidStatus, InvalidHandshake) as exc:
        await _handle_ws_auth_exception(exc)
        if _exception_status_code(exc) in AUTH_WS_STATUS_CODES:
            raise HubWebSocketAuthError("hub websocket auth rejected") from exc
        raise


class HubWebSocketManager:
    """Small background manager for the desktop-to-hub WebSocket session."""

    def __init__(
        self,
        config: ApiConfig | None = None,
        *,
        reconnect_initial_seconds: float = 1.0,
        reconnect_max_seconds: float = 30.0,
    ):
        self.config = config
        self.reconnect_initial_seconds = reconnect_initial_seconds
        self.reconnect_max_seconds = reconnect_max_seconds
        self._task: asyncio.Task | None = None
        self._stop_requested = False
        self._connected = False
        self._verified = False
        self._status: HubWsStatus = "disconnected"
        self._last_error: str | None = None
        self._connected_event: asyncio.Event | None = None

    @property
    def is_running(self) -> bool:
        return self._task is not None and not self._task.done()

    @property
    def is_connected(self) -> bool:
        return self.is_running and self._connected

    @property
    def is_verified(self) -> bool:
        return self.is_connected and self._verified

    def status_payload(self) -> dict[str, Any]:
        return {
            "hub_ws_connected": self.is_connected,
            "hub_ws_verified": self.is_verified,
            "hub_ws_status": self._status,
            "hub_ws_error": self._last_error,
        }

    def _set_state(
        self,
        status: HubWsStatus,
        *,
        connected: bool | None = None,
        verified: bool | None = None,
        error: str | None = None,
    ) -> None:
        self._status = status
        if connected is not None:
            self._connected = connected
        if verified is not None:
            self._verified = verified
        self._last_error = error

    async def start(self, *, wait_connected: bool = False) -> dict[str, Any]:
        if self.is_running:
            if wait_connected and not self.is_connected and self._connected_event:
                try:
                    await asyncio.wait_for(self._connected_event.wait(), timeout=HUB_WS_START_TIMEOUT_SECONDS)
                except asyncio.TimeoutError:
                    self._set_state("error", connected=False, verified=False, error="Timed out connecting hub WebSocket.")
            return self.status_payload()

        try:
            await _load_ws_credentials()
        except HubWebSocketLoginRequiredError as exc:
            self._set_state("disconnected", connected=False, verified=False, error=str(exc))
            return self.status_payload()
        except HubWebSocketAuthError as exc:
            self._set_state("error", connected=False, verified=False, error=str(exc))
            return self.status_payload()

        self._stop_requested = False
        self._connected_event = asyncio.Event()
        self._set_state("connecting", connected=False, verified=False, error=None)
        self._task = asyncio.create_task(self._run_forever(), name="hub-ws-client")
        if wait_connected:
            try:
                await asyncio.wait_for(self._connected_event.wait(), timeout=HUB_WS_START_TIMEOUT_SECONDS)
            except asyncio.TimeoutError:
                self._set_state("error", connected=False, verified=False, error="Timed out connecting hub WebSocket.")
        return self.status_payload()

    async def stop(self) -> dict[str, Any]:
        self.request_stop()
        task = self._task
        if not task or task.done() or asyncio.current_task() is task:
            self._set_state("disconnected", connected=False, verified=False, error=None)
            return self.status_payload()
        try:
            await task
        except asyncio.CancelledError:
            pass
        self._set_state("disconnected", connected=False, verified=False, error=None)
        return self.status_payload()

    async def restart(self, *, wait_connected: bool = False) -> dict[str, Any]:
        await self.stop()
        return await self.start(wait_connected=wait_connected)

    def request_stop(self) -> None:
        self._stop_requested = True
        self._connected = False
        self._verified = False
        self._status = "disconnected"
        self._last_error = None
        task = self._task
        if not task or task.done():
            return

        try:
            current_task = asyncio.current_task()
        except RuntimeError:
            current_task = None

        if current_task is not task:
            task.cancel()

    async def _run_forever(self) -> None:
        backoff = self.reconnect_initial_seconds
        try:
            while not self._stop_requested:
                try:
                    self._set_state("connecting", connected=False, verified=False, error=None)
                    async with connect_hub_websocket(self.config) as websocket:
                        backoff = self.reconnect_initial_seconds
                        self._set_state("verified" if self._verified else "connected", connected=True, error=None)
                        if self._connected_event:
                            self._connected_event.set()
                        async for raw_message in websocket:
                            await self._handle_message(raw_message)
                except asyncio.CancelledError:
                    raise
                except HubWebSocketLoginRequiredError as exc:
                    self._set_state("disconnected", connected=False, verified=False, error=str(exc))
                    return
                except HubWebSocketAuthError as exc:
                    self._set_state("error", connected=False, verified=False, error=str(exc))
                    return
                except (ConnectionClosedError, ConnectionClosed) as exc:
                    if await self._handle_closed_connection(exc):
                        return
                    self._set_state("disconnected", connected=False, verified=False, error=None)
                except Exception as exc:
                    logger.info("Hub WS listener disconnected: %s", exc)
                    self._set_state("error", connected=False, verified=False, error=str(exc))

                if not self._stop_requested:
                    await asyncio.sleep(backoff)
                    backoff = min(backoff * 2, self.reconnect_max_seconds)
        finally:
            if asyncio.current_task() is self._task:
                self._task = None
            if self._stop_requested:
                self._set_state("disconnected", connected=False, verified=False, error=None)

    async def _handle_closed_connection(self, exc: ConnectionClosed) -> bool:
        if exc.code in AUTH_WS_CLOSE_CODES:
            creds = load_credentials()
            reason = "expired" if creds and creds.is_expired(EXPIRY_LEEWAY_SECONDS) else "rejected"
            await invalidate_hub_login(reason)
            self._set_state("error", connected=False, verified=False, error="Hub WebSocket authentication was rejected.")
            return True
        logger.info("Hub WS listener closed: code=%s reason=%s", exc.code, exc.reason)
        return False

    async def verify_current_user(self, config: ApiConfig | None = None) -> dict[str, Any]:
        """Verify hub WS auth by comparing hub current-user data to local cloud profile."""
        from flow_sdk.api.messages import APIMessage
        from flow_sdk.cli.app_config import get_user

        local_user = get_user() or {}
        local_user_id = local_user.get("id")
        if not local_user_id:
            self._set_state("disconnected", connected=False, verified=False, error="Cloud login required before connecting hub WebSocket.")
            raise HubWebSocketLoginRequiredError("Cloud login required before connecting hub WebSocket.")

        try:
            async with connect_hub_websocket(config or self.config, connection_id=str(uuid.uuid4())) as websocket:
                await websocket.send(APIMessage(direct_resource_type="user").model_dump_json())
                raw_message = await asyncio.wait_for(websocket.recv(), timeout=HUB_WS_VERIFY_TIMEOUT_SECONDS)
        except HubWebSocketAuthError:
            self._set_state("error", connected=False, verified=False, error="Hub WebSocket authentication failed.")
            raise
        except Exception as exc:
            self._set_state("error", connected=False, verified=False, error=str(exc))
            raise HubWebSocketVerificationError(str(exc)) from exc

        try:
            response = json.loads(raw_message)
        except json.JSONDecodeError as exc:
            self._set_state("error", connected=False, verified=False, error="Hub WebSocket returned invalid JSON.")
            raise HubWebSocketVerificationError("Hub WebSocket returned invalid JSON.") from exc

        if str(response.get("status") or "").lower() != "success":
            message = response.get("message") or "Hub WebSocket verification failed."
            self._set_state("error", connected=False, verified=False, error=str(message))
            raise HubWebSocketVerificationError(str(message))

        data = response.get("data")
        hub_users = data if isinstance(data, list) else [data] if isinstance(data, dict) else []
        matching_user = next((user for user in hub_users if isinstance(user, dict) and user.get("id") == local_user_id), None)
        if not matching_user:
            hub_ids = [user.get("id") for user in hub_users if isinstance(user, dict) and user.get("id")]
            message = f"Hub WebSocket user mismatch: local={local_user_id}, hub={hub_ids or 'none'}"
            self._set_state("error", connected=False, verified=False, error=message)
            raise HubWebSocketVerificationError(message)

        self._verified = True
        self._last_error = None
        if self.is_connected:
            self._status = "verified"
        return {
            "verified": True,
            "local_user_id": local_user_id,
            "hub_user_id": matching_user.get("id"),
            "hub_user": matching_user,
        }

    async def _handle_message(self, raw_message: Any) -> None:
        # No registered consumers — debug-only sink. Skip the JSON parse
        # entirely when DEBUG isn't being captured.
        if not isinstance(raw_message, str) or not logger.isEnabledFor(logging.DEBUG):
            return
        try:
            message = json.loads(raw_message)
        except json.JSONDecodeError:
            logger.debug("Ignoring non-JSON hub WS message: %r", raw_message[:200])
            return
        logger.debug("Received hub WS message: %s", message.get("message_type"))


hub_ws_manager = HubWebSocketManager()
