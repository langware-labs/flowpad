"""Outbound WebSocket client for authenticated hub communication."""

from __future__ import annotations

import asyncio
import json
import logging
import ssl
import uuid
from contextlib import asynccontextmanager
from functools import lru_cache
from typing import Any, Awaitable, Callable
from urllib.parse import urlsplit, urlunsplit

import websockets
from websockets.exceptions import (
    ConnectionClosed,
    ConnectionClosedError,
    InvalidHandshake,
    InvalidStatus,
)

from flow_sdk.cli.auth.credentials import UserHubCredentials, load_credentials
from flow_sdk.cloud_client.auth_state import invalidate_hub_login, set_connection_status
from flow_sdk.cloud_client.auth_status import HubConnectionStatus
from flow_sdk.cloud_client.client import ApiConfig
from flow_sdk.cloud_client.constants import EXPIRY_LEEWAY_SECONDS

InboundHandler = Callable[[dict], Awaitable[None]]
HUB_WS_REQUEST_DEFAULT_TIMEOUT_SECONDS = 10.0
HUB_WS_OUTBOUND_QUEUE_MAX = 256


logger = logging.getLogger(__name__)

AUTH_WS_STATUS_CODES = {401, 403, 412, 424}
AUTH_WS_CLOSE_CODES = {1008}
HUB_WS_VERIFY_TIMEOUT_SECONDS = 10.0
HUB_WS_START_TIMEOUT_SECONDS = 5.0


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


@lru_cache(maxsize=1)
def _hub_ssl_context() -> ssl.SSLContext:
    """TLS context for the hub WebSocket, trusting certifi's CA bundle.

    All REST/login traffic goes through ``httpx``, which verifies against
    certifi's bundle and therefore succeeds everywhere. ``websockets`` does
    NOT use certifi — left to itself it builds ``ssl.create_default_context()``
    over OpenSSL's *system* trust store, which on many machines (python.org
    macOS builds, slim Linux images, locked-down corporate laptops) is missing
    the issuer chain. The result is a client that is "logged in" over HTTPS but
    fails the wss:// handshake with
    ``[SSL: CERTIFICATE_VERIFY_FAILED] unable to get local issuer certificate``.

    Build the WS context from certifi (matching httpx) and ALSO load the OS
    store + ``SSL_CERT_FILE``/``SSL_CERT_DIR`` env, so the union covers both
    cert-less machines and corporate-proxy CAs.
    """
    import certifi

    context = ssl.create_default_context(cafile=certifi.where())
    try:
        context.load_default_certs()
    except Exception:  # noqa: BLE001 — OS store is best-effort; certifi already loaded
        logger.debug("hub WS SSL: load_default_certs() failed; using certifi bundle only", exc_info=True)
    return context


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
    """Hub WS rejected our credentials at handshake time.

    This is a CONNECTION-layer failure, not a credential-loss event. Mark
    the connection as ``AUTH_REJECTED`` so the UI surfaces a connection
    warning, but leave login state alone — the user can still use cached
    cloud data and try Reconnect.
    """
    status_code = _exception_status_code(exc)
    if status_code in AUTH_WS_STATUS_CODES:
        error = f"hub rejected WS auth (HTTP {status_code})"
        await set_connection_status(HubConnectionStatus.AUTH_REJECTED, error=error)


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
    # wss:// must verify against certifi (see _hub_ssl_context); ws:// (local
    # dev) carries no TLS, so leave ssl unset.
    ssl_context = _hub_ssl_context() if url.startswith("wss://") else None

    try:
        async with websockets.connect(
            url,
            additional_headers=headers,
            open_timeout=open_timeout,
            proxy=None,
            ssl=ssl_context,
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
        reconnect_attempts_per_level: int = 5,
    ):
        self.config = config
        self.reconnect_initial_seconds = reconnect_initial_seconds
        self.reconnect_max_seconds = reconnect_max_seconds
        # Each backoff level (1s, 2s, 4s, 8s, 16s, 30s) is retried this many
        # times before doubling. "On each disconnect, get this many attempts
        # at the current cadence before stepping up."
        self.reconnect_attempts_per_level = max(1, int(reconnect_attempts_per_level))
        self._task: asyncio.Task | None = None
        self._stop_requested = False
        # Id for THIS backend's CURRENT hub WS connection, minted FRESH per
        # connect attempt in ``_run_forever`` (NOT pinned). A reconnect MUST use
        # a new id: the hub keys its live ``Connection`` handler by this id and
        # rejects a reused id as a duplicate (``WS_CLOSE_DUPLICATE``) whenever a
        # prior half-open connection's handler hasn't been cleaned up — which
        # would wedge the bridge permanently. ``BrowserContextWatch`` survives
        # reconnects via ``resync()`` (re-registers watches against the new id),
        # NOT via id stability. ``None`` until the first connect.
        self._connection_id: str | None = None
        self._connected = False
        self._verified = False
        self._status: HubConnectionStatus = HubConnectionStatus.DISCONNECTED
        self._last_error: str | None = None
        self._connected_event: asyncio.Event | None = None
        # Inbound dispatcher: message_type → handler. Replaces the prior
        # debug-log-only sink. Handlers are awaited inside the reader loop;
        # heavy work should be offloaded to its own task.
        self._inbound_handlers: dict[str, InboundHandler] = {}
        # Outbound queue + per-request future map for send_request correlation.
        # Both are recreated on each reconnect cycle so prior pending frames
        # don't leak across sessions.
        self._outbound: asyncio.Queue[dict] | None = None
        self._pending_requests: dict[str, asyncio.Future[dict]] = {}

    def register_handler(self, message_type: str, handler: InboundHandler) -> None:
        """Register an inbound handler. Last writer wins; pass None to remove."""
        if handler is None:
            self._inbound_handlers.pop(message_type, None)
            return
        self._inbound_handlers[message_type] = handler

    def send(self, message: dict) -> None:
        """Enqueue a message for delivery to the hub WS.

        Fire-and-forget. If the WS is not currently connected the message is
        held in the queue and flushed on reconnect (up to ``HUB_WS_OUTBOUND_QUEUE_MAX``
        — additional sends raise ``asyncio.QueueFull``). Messages without a
        ``message_id`` get one assigned in-place.
        """
        if "message_id" not in message:
            message["message_id"] = str(uuid.uuid4())
        if self._outbound is None:
            self._outbound = asyncio.Queue(maxsize=HUB_WS_OUTBOUND_QUEUE_MAX)
        self._outbound.put_nowait(message)

    async def send_request(
        self,
        message: dict,
        *,
        timeout: float = HUB_WS_REQUEST_DEFAULT_TIMEOUT_SECONDS,
    ) -> dict:
        """Enqueue a message and await the matching ``response_msg``.

        Returns the response payload (the ``content`` field of the
        ``response_msg`` if present, else the full frame). Raises
        ``asyncio.TimeoutError`` on no response within ``timeout``, or
        ``HubWebSocketError``/connection-closed on disconnect mid-request.
        """
        message_id = message.get("message_id") or str(uuid.uuid4())
        message["message_id"] = message_id
        future: asyncio.Future[dict] = asyncio.Future()
        self._pending_requests[message_id] = future
        try:
            self.send(message)
            response = await asyncio.wait_for(future, timeout=timeout)
        finally:
            self._pending_requests.pop(message_id, None)
        return response

    def _fail_pending(self, exc: BaseException) -> None:
        """Cancel/fault all in-flight send_request futures (used on disconnect)."""
        for fut in list(self._pending_requests.values()):
            if not fut.done():
                fut.set_exception(exc)
        self._pending_requests.clear()

    @property
    def is_running(self) -> bool:
        return self._task is not None and not self._task.done()

    @property
    def is_connected(self) -> bool:
        return self.is_running and self._connected

    @property
    def is_verified(self) -> bool:
        return self.is_connected and self._verified

    @property
    def connection_id(self) -> str | None:
        """This backend's session-stable hub connection id (``None`` until started).

        Used by ``BrowserContextWatch`` to register hub watches against the live
        bridge connection — the hub keys its ``Connection`` entity by this id.
        """
        return self._connection_id

    def connection_payload(self) -> dict[str, Any]:
        """Canonical {status, error} for the hub WS connection slot."""
        return {
            "status": self._status.value,
            "error": self._last_error,
        }

    def status_payload(self) -> dict[str, Any]:
        """Legacy flat shape — kept for back-compat callers (error responses, etc.)."""
        return {
            "hub_ws_connected": self.is_connected,
            "hub_ws_verified": self.is_verified,
            "hub_ws_status": self._status.value,
            "hub_ws_error": self._last_error,
        }

    async def _set_state(
        self,
        status: HubConnectionStatus,
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
        await set_connection_status(status, error=error)

    async def start(self, *, wait_connected: bool = False) -> dict[str, Any]:
        if self.is_running:
            if wait_connected and not self.is_connected and self._connected_event:
                try:
                    await asyncio.wait_for(self._connected_event.wait(), timeout=HUB_WS_START_TIMEOUT_SECONDS)
                except asyncio.TimeoutError:
                    await self._set_state(HubConnectionStatus.ERROR, connected=False, verified=False, error="Timed out connecting hub WebSocket.")
            return self.status_payload()

        try:
            await _load_ws_credentials()
        except HubWebSocketLoginRequiredError as exc:
            await self._set_state(HubConnectionStatus.DISCONNECTED, connected=False, verified=False, error=str(exc))
            return self.status_payload()
        except HubWebSocketAuthError as exc:
            await self._set_state(HubConnectionStatus.ERROR, connected=False, verified=False, error=str(exc))
            return self.status_payload()

        self._stop_requested = False
        self._connected_event = asyncio.Event()
        await self._set_state(HubConnectionStatus.CONNECTING, connected=False, verified=False, error=None)
        self._task = asyncio.create_task(self._run_forever(), name="hub-ws-client")
        if wait_connected:
            try:
                await asyncio.wait_for(self._connected_event.wait(), timeout=HUB_WS_START_TIMEOUT_SECONDS)
            except asyncio.TimeoutError:
                await self._set_state(HubConnectionStatus.ERROR, connected=False, verified=False, error="Timed out connecting hub WebSocket.")
        return self.status_payload()

    async def stop(self) -> dict[str, Any]:
        self.request_stop()
        task = self._task
        if not task or task.done() or asyncio.current_task() is task:
            await self._set_state(HubConnectionStatus.DISCONNECTED, connected=False, verified=False, error=None)
            return self.status_payload()
        try:
            await task
        except asyncio.CancelledError:
            pass
        await self._set_state(HubConnectionStatus.DISCONNECTED, connected=False, verified=False, error=None)
        return self.status_payload()

    async def restart(self, *, wait_connected: bool = False) -> dict[str, Any]:
        await self.stop()
        return await self.start(wait_connected=wait_connected)

    def request_stop(self) -> None:
        """Synchronously signal the run loop to stop.

        Mutates in-memory state only; the connection-status broadcast is
        emitted by callers (``stop()`` calls ``_set_state`` after; the logout
        path in ``clear_cloud_credentials`` broadcasts DISCONNECTED itself).
        """
        self._stop_requested = True
        self._connected = False
        self._verified = False
        self._status = HubConnectionStatus.DISCONNECTED
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

    async def _reader_loop(self, websocket) -> None:
        async for raw_message in websocket:
            await self._handle_message(raw_message)

    async def _writer_loop(self, websocket) -> None:
        assert self._outbound is not None
        while True:
            message = await self._outbound.get()
            await websocket.send(json.dumps(message))

    async def _run_forever(self) -> None:
        backoff = self.reconnect_initial_seconds
        attempts_at_level = 0
        try:
            while not self._stop_requested:
                try:
                    await self._set_state(HubConnectionStatus.CONNECTING, connected=False, verified=False, error=None)
                    # Fresh id every connect attempt — never reuse (see
                    # ``_connection_id`` doc: a reused id collides with a stale
                    # hub-side ghost handler and is rejected as a duplicate).
                    self._connection_id = str(uuid.uuid4())
                    async with connect_hub_websocket(self.config, connection_id=self._connection_id) as websocket:
                        backoff = self.reconnect_initial_seconds
                        attempts_at_level = 0
                        await self._set_state(
                            HubConnectionStatus.VERIFIED if self._verified else HubConnectionStatus.CONNECTED,
                            connected=True,
                            error=None,
                        )
                        if self._connected_event:
                            self._connected_event.set()
                        # Re-register BrowserContextWatch hub watches against the
                        # freshly-(re)connected ``Connection`` (idempotent). Runs
                        # as a task so it doesn't delay the reader/writer below.
                        from flow_sdk.cloud_client.context_watch import browser_context_watch

                        asyncio.create_task(browser_context_watch.resync())
                        # Fresh queue per connection — prior queued frames from
                        # a dead session don't leak across reconnects.
                        self._outbound = asyncio.Queue(maxsize=HUB_WS_OUTBOUND_QUEUE_MAX)
                        reader_task = asyncio.create_task(self._reader_loop(websocket))
                        writer_task = asyncio.create_task(self._writer_loop(websocket))
                        try:
                            done, pending = await asyncio.wait(
                                {reader_task, writer_task},
                                return_when=asyncio.FIRST_COMPLETED,
                            )
                        finally:
                            for task in (reader_task, writer_task):
                                if not task.done():
                                    task.cancel()
                            for task in (reader_task, writer_task):
                                try:
                                    await task
                                except (asyncio.CancelledError, ConnectionClosed, ConnectionClosedError):
                                    pass
                                except Exception:
                                    pass
                        # Surface a non-cancel exception from whichever task
                        # finished first so the outer except blocks classify it.
                        for task in done:
                            exc = task.exception()
                            if exc and not isinstance(exc, asyncio.CancelledError):
                                raise exc
                except asyncio.CancelledError:
                    raise
                except HubWebSocketLoginRequiredError as exc:
                    self._fail_pending(exc)
                    await self._set_state(HubConnectionStatus.DISCONNECTED, connected=False, verified=False, error=str(exc))
                    return
                except HubWebSocketAuthError as exc:
                    self._fail_pending(exc)
                    # Hub rejected our credentials at the WS layer. Stop the
                    # reconnect loop and surface AUTH_REJECTED — login state
                    # is left alone (see `_handle_ws_auth_exception`).
                    await self._set_state(HubConnectionStatus.AUTH_REJECTED, connected=False, verified=False, error=str(exc))
                    return
                except (ConnectionClosedError, ConnectionClosed) as exc:
                    self._fail_pending(exc)
                    if await self._handle_closed_connection(exc):
                        return
                    await self._set_state(HubConnectionStatus.DISCONNECTED, connected=False, verified=False, error=None)
                except Exception as exc:
                    self._fail_pending(exc)
                    logger.info("Hub WS listener disconnected: %s", exc)
                    await self._set_state(HubConnectionStatus.ERROR, connected=False, verified=False, error=str(exc))

                if not self._stop_requested:
                    await asyncio.sleep(backoff)
                    attempts_at_level += 1
                    if attempts_at_level >= self.reconnect_attempts_per_level:
                        backoff = min(backoff * 2, self.reconnect_max_seconds)
                        attempts_at_level = 0
        finally:
            self._fail_pending(RuntimeError("Hub WebSocket session ended."))
            self._outbound = None
            if asyncio.current_task() is self._task:
                self._task = None
            if self._stop_requested:
                await self._set_state(HubConnectionStatus.DISCONNECTED, connected=False, verified=False, error=None)

    async def _handle_closed_connection(self, exc: ConnectionClosed) -> bool:
        if exc.code in AUTH_WS_CLOSE_CODES:
            creds = load_credentials()
            locally_expired = bool(creds and creds.is_expired(EXPIRY_LEEWAY_SECONDS))
            reason = "expired" if locally_expired else "rejected"
            # Hub-side auth close — treat as canonical credential loss whether
            # the local clock agrees or not. If the hub said no, the token is
            # no longer valid; reason just disambiguates the cause for telemetry.
            await invalidate_hub_login(reason)
            await self._set_state(
                HubConnectionStatus.DISCONNECTED,
                connected=False,
                verified=False,
                error="Hub auth expired." if locally_expired else "Hub WebSocket authentication was rejected.",
            )
            return True
        logger.info("Hub WS listener closed: code=%s reason=%s", exc.code, exc.reason)
        return False

    async def verify_current_user(self, config: ApiConfig | None = None) -> dict[str, Any]:
        """Verify hub WS auth by comparing hub current-user data to local cloud profile."""
        from flow_sdk.api.messages import APIMessage, WSMessageType
        from flow_sdk.cli.app_config import get_user

        local_user = get_user() or {}
        local_user_id = local_user.get("id")
        if not local_user_id:
            await self._set_state(HubConnectionStatus.DISCONNECTED, connected=False, verified=False, error="Cloud login required before connecting hub WebSocket.")
            raise HubWebSocketLoginRequiredError("Cloud login required before connecting hub WebSocket.")

        try:
            async with connect_hub_websocket(config or self.config, connection_id=str(uuid.uuid4())) as websocket:
                await websocket.send(APIMessage(direct_resource_type="user").model_dump_json())
                raw_message = await asyncio.wait_for(websocket.recv(), timeout=HUB_WS_VERIFY_TIMEOUT_SECONDS)
        except HubWebSocketAuthError:
            await self._set_state(HubConnectionStatus.AUTH_REJECTED, connected=False, verified=False, error="Hub WebSocket authentication failed.")
            raise
        except Exception as exc:
            await self._set_state(HubConnectionStatus.ERROR, connected=False, verified=False, error=str(exc))
            raise HubWebSocketVerificationError(str(exc)) from exc

        try:
            response = json.loads(raw_message)
        except json.JSONDecodeError as exc:
            await self._set_state(HubConnectionStatus.ERROR, connected=False, verified=False, error="Hub WebSocket returned invalid JSON.")
            raise HubWebSocketVerificationError("Hub WebSocket returned invalid JSON.") from exc

        # The hub wraps rest_api_msg replies in a response_msg envelope;
        # unwrap to the ApiResponse payload before reading status/data.
        if isinstance(response, dict) and response.get("message_type") == WSMessageType.RESPONSE_MSG.value:
            response = response.get("content") or {}

        if str(response.get("status") or "").lower() != "success":
            message = response.get("message") or "Hub WebSocket verification failed."
            await self._set_state(HubConnectionStatus.ERROR, connected=False, verified=False, error=str(message))
            raise HubWebSocketVerificationError(str(message))

        data = response.get("data")
        hub_users = data if isinstance(data, list) else [data] if isinstance(data, dict) else []
        matching_user = next((user for user in hub_users if isinstance(user, dict) and user.get("id") == local_user_id), None)
        if not matching_user:
            hub_ids = [user.get("id") for user in hub_users if isinstance(user, dict) and user.get("id")]
            message = f"Hub WebSocket user mismatch: local={local_user_id}, hub={hub_ids or 'none'}"
            await self._set_state(HubConnectionStatus.ERROR, connected=False, verified=False, error=message)
            raise HubWebSocketVerificationError(message)

        self._verified = True
        self._last_error = None
        if self.is_connected:
            await self._set_state(HubConnectionStatus.VERIFIED, connected=True, verified=True, error=None)
        return {
            "verified": True,
            "local_user_id": local_user_id,
            "hub_user_id": matching_user.get("id"),
            "hub_user": matching_user,
        }

    async def _handle_message(self, raw_message: Any) -> None:
        if not isinstance(raw_message, str):
            return
        try:
            message = json.loads(raw_message)
        except json.JSONDecodeError:
            logger.debug("Ignoring non-JSON hub WS message: %r", raw_message[:200])
            return
        if not isinstance(message, dict):
            return
        message_type = message.get("message_type")

        # Correlate response_msg back to send_request awaiters first.
        if message_type == "response_msg":
            response_id = message.get("response_message_id") or message.get("message_id")
            future = self._pending_requests.pop(response_id, None) if response_id else None
            if future and not future.done():
                # Resolve with `content` when the hub wraps a payload, otherwise
                # the full frame so callers can inspect status/error fields.
                future.set_result(message.get("content") if "content" in message else message)
                return

        handler = self._inbound_handlers.get(message_type) if message_type else None
        if handler is None:
            if logger.isEnabledFor(logging.DEBUG):
                logger.debug("Hub WS: no handler for message_type=%r", message_type)
            return
        try:
            await handler(message)
        except Exception:
            logger.exception("Hub WS inbound handler raised for message_type=%s", message_type)


hub_ws_manager = HubWebSocketManager()
