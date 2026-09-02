"""One staged connection state machine shared by Python and CLI surfaces."""

from __future__ import annotations

import asyncio
from typing import Protocol
from urllib.parse import quote

from filelock import FileLock, Timeout

from flow_sdk.core.connections.types import (
    Authorization,
    BrowserAuthorization,
    ConnectionCancelled,
    ConnectionConnectError,
    ConnectionResult,
    ConnectionStage,
    ConnectionTestResult,
    DeviceAuthorization,
)


class AuthorizationPresenter(Protocol):
    async def present(self, authorization: Authorization) -> None: ...


def _error(
    provider: str,
    stage: ConnectionStage,
    code: str,
    detail: str | None = None,
) -> ConnectionConnectError:
    return ConnectionConnectError(provider, stage, code, detail)


def _normalize_provider(provider: str) -> str:
    from flow_sdk.instances.errors import NameInvalid
    from flow_sdk.instances.paths import validate_name

    normalized = (provider or "").strip().lower()
    try:
        return validate_name(normalized)
    except NameInvalid as exc:
        raise _error(provider or "", ConnectionStage.CATALOG, "invalid_provider", str(exc)) from exc


def _test_result(data) -> ConnectionTestResult:
    if not isinstance(data, dict) or data.get("ok") not in (True, False, None):
        raise ValueError("invalid connection test response")
    return ConnectionTestResult(
        ok=data.get("ok"),
        identity=data.get("identity"),
        account_key=data.get("account_key"),
        detail=data.get("detail"),
        code=data.get("code"),
    )


async def _test_with_client(provider: str, client) -> ConnectionTestResult:
    response = await client.request("GET", f"/api/v1/graph/oauth/{quote(provider, safe='')}/test")
    if not response.success:
        raise _error(
            provider,
            ConnectionStage.VERIFICATION,
            response.error_code or "test_failed",
            response.message,
        )
    try:
        return _test_result(response.data)
    except ValueError as exc:
        raise _error(provider, ConnectionStage.VERIFICATION, "invalid_response", str(exc)) from exc


async def test(provider: str) -> ConnectionTestResult:
    from flow_sdk.core.connections.service import FlowServiceError, flow_service
    from flow_sdk.core.connections.specs import _list_connection_specs_with_client

    try:
        async with flow_service() as lease:
            wanted = provider.strip().lower()
            specs = await _list_connection_specs_with_client(lease.client)
            spec = next((item for item in specs if item.provider.lower() == wanted), None)
            if spec is None:
                raise _error(provider, ConnectionStage.CATALOG, "unknown_provider")
            return await _test_with_client(spec.provider, lease.client)
    except FlowServiceError as exc:
        raise _error(provider, ConnectionStage.SERVICE, exc.code, exc.detail) from exc


async def _ensure_secrets(provider: str, client) -> None:
    status = await client.request("GET", "/api/v1/graph/secrets/is-enabled")
    if not status.success or not isinstance(status.data, dict):
        raise _error(
            provider,
            ConnectionStage.SECRETS,
            status.error_code or "secrets_status_failed",
            status.message,
        )
    if status.data.get("enabled") is True:
        return
    enabled = await client.request("POST", "/api/v1/graph/secrets/enable", json={})
    if not enabled.success or not isinstance(enabled.data, dict) or enabled.data.get("enabled") is not True:
        raise _error(
            provider,
            ConnectionStage.SECRETS,
            enabled.error_code or "secrets_enable_failed",
            enabled.message,
        )
    rechecked = await client.request("GET", "/api/v1/graph/secrets/is-enabled")
    if not rechecked.success or not isinstance(rechecked.data, dict) or rechecked.data.get("enabled") is not True:
        raise _error(provider, ConnectionStage.SECRETS, "secrets_not_enabled")


def _authorization(provider: str, data) -> Authorization:
    if not isinstance(data, dict):
        raise _error(provider, ConnectionStage.AUTHORIZATION, "invalid_response")
    request_id = str(data.get("oauth_request_id") or data.get("state") or "").strip()
    if not request_id:
        raise _error(provider, ConnectionStage.AUTHORIZATION, "missing_request_id")
    verification_uri = str(data.get("verification_uri") or "").strip()
    user_code = str(data.get("user_code") or "").strip()
    if verification_uri and user_code:
        return DeviceAuthorization(request_id, provider, verification_uri, user_code)
    url = str(data.get("auth_url") or data.get("url") or "").strip()
    if url:
        return BrowserAuthorization(request_id, provider, url)
    raise _error(provider, ConnectionStage.AUTHORIZATION, "invalid_response")


async def _cancel_exact(client, authorization: Authorization) -> None:
    provider = quote(authorization.provider, safe="")
    request_id = quote(authorization.oauth_request_id, safe="")
    try:
        await client.request("POST", f"/api/v1/graph/oauth/{provider}/cancel?state={request_id}", json={})
    except Exception:  # noqa: BLE001 — cancellation remains native and exact
        pass


async def _wait_exact(client, authorization: Authorization) -> None:
    provider = quote(authorization.provider, safe="")
    request_id = quote(authorization.oauth_request_id, safe="")
    while True:
        response = await client.request("GET", f"/api/v1/graph/oauth/{provider}/wait-callback?state={request_id}")
        if not response.success:
            code = response.error_code or "authorization_failed"
            if code in {"cancelled", "access_denied", "authorization_denied"}:
                raise ConnectionCancelled(authorization.provider, response.message)
            raise _error(
                authorization.provider,
                ConnectionStage.CALLBACK,
                code,
                response.message,
            )
        data = response.data if isinstance(response.data, dict) else {}
        status = str(data.get("status") or "success").lower()
        if status in {"pending", "polling"}:
            continue
        if status == "success":
            return
        if status in {"cancelled", "denied"}:
            raise ConnectionCancelled(
                authorization.provider,
                str(data.get("detail") or response.message or status),
            )
        raise _error(
            authorization.provider,
            ConnectionStage.CALLBACK,
            str(data.get("code") or "authorization_failed"),
            str(data.get("detail") or response.message or status),
        )


async def _cancel_cloud_exact(client, oauth_request_id: str) -> None:
    try:
        await client.request(
            "POST",
            f"/api/v1/cloud/login/cancel?oauth_request_id={quote(oauth_request_id, safe='')}",
            json={},
        )
    except Exception:  # noqa: BLE001
        pass


async def _ensure_cloud_login(provider: str, client, presenter: AuthorizationPresenter) -> None:
    started = await client.request("POST", "/api/v1/cloud/login/correlated", json={})
    if not started.success or not isinstance(started.data, dict):
        raise _error(
            provider,
            ConnectionStage.CLOUD,
            started.error_code or "cloud_login_failed",
            started.message,
        )
    if str(started.data.get("status") or "").lower() == "success":
        return
    request_id = str(started.data.get("oauth_request_id") or "").strip()
    url = str(started.data.get("url") or "").strip()
    if not request_id or not url:
        raise _error(provider, ConnectionStage.CLOUD, "invalid_response")
    authorization = BrowserAuthorization(request_id, "flowpad_cloud", url)
    try:
        if started.data.get("present") is not False:
            await presenter.present(authorization)
        while True:
            try:
                result = await client.request(
                    "GET",
                    f"/api/v1/cloud/login/wait?oauth_request_id={quote(request_id, safe='')}",
                )
            except Exception as exc:  # noqa: BLE001
                from flow_sdk.core.connections.service import FlowServiceError  # noqa: PLC0415

                if isinstance(exc, FlowServiceError):
                    raise
                raise _error(
                    provider,
                    ConnectionStage.CLOUD,
                    "cloud_wait_transport",
                    str(exc) or type(exc).__name__,
                ) from exc
            if not result.success or not isinstance(result.data, dict):
                raise _error(
                    provider,
                    ConnectionStage.CLOUD,
                    result.error_code or "cloud_login_failed",
                    result.message,
                )
            status = str(result.data.get("status") or "error").lower()
            if status == "pending":
                continue
            if status == "success":
                return
            if status == "cancelled":
                raise ConnectionCancelled(provider, "Cloud login was cancelled")
            raise _error(
                provider,
                ConnectionStage.CLOUD,
                str(result.data.get("code") or "cloud_login_failed"),
                result.data.get("detail"),
            )
    except asyncio.CancelledError:
        await asyncio.shield(_cancel_cloud_exact(client, request_id))
        raise
    except BaseException:
        await _cancel_cloud_exact(client, request_id)
        raise


def _acquire_provider_lock(provider: str) -> FileLock:
    from flow_sdk.instance_settings import get_instance_settings
    from flow_sdk.instances.paths import connection_provider_lock_path

    provider = _normalize_provider(provider)
    settings = get_instance_settings()
    settings.instance_dir.mkdir(parents=True, exist_ok=True)
    lock = FileLock(
        str(connection_provider_lock_path(settings.instance_name, provider)),
        timeout=0,
    )
    try:
        lock.acquire()
    except Timeout as exc:
        raise _error(provider, ConnectionStage.AUTHORIZATION, "connection_busy") from exc
    return lock


async def connect(provider: str, presenter: AuthorizationPresenter) -> ConnectionResult:
    from flow_sdk.core.connections.service import FlowServiceError, flow_service
    from flow_sdk.core.connections.specs import _list_connection_specs_with_client

    provider = _normalize_provider(provider)
    provider_lock = _acquire_provider_lock(provider)
    try:
        try:
            async with flow_service() as lease:
                client = lease.client
                specs = await _list_connection_specs_with_client(client)
                wanted = provider.lower()
                spec = next((item for item in specs if item.provider.lower() == wanted), None)
                if spec is None:
                    raise _error(provider, ConnectionStage.CATALOG, "unknown_provider")

                await _ensure_secrets(spec.provider, client)
                initial = await _test_with_client(spec.provider, client)
                if initial.ok is True:
                    return ConnectionResult(spec=spec, test=initial)
                if initial.ok is None:
                    raise _error(
                        spec.provider,
                        ConnectionStage.VERIFICATION,
                        initial.code or "verification_unreachable",
                        initial.detail,
                    )

                auth_response = await client.request(
                    "POST", f"/api/v1/graph/oauth/{quote(spec.provider, safe='')}/auth", json={}
                )
                if not auth_response.success and auth_response.error_code == "cloud_login_required":
                    await _ensure_cloud_login(spec.provider, client, presenter)
                    auth_response = await client.request(
                        "POST",
                        f"/api/v1/graph/oauth/{quote(spec.provider, safe='')}/auth",
                        json={},
                    )
                if not auth_response.success:
                    stage = (
                        ConnectionStage.CLOUD
                        if auth_response.error_code in {"cloud_login_required", "hub_unavailable"}
                        else ConnectionStage.AUTHORIZATION
                    )
                    raise _error(
                        spec.provider,
                        stage,
                        auth_response.error_code or "authorization_failed",
                        auth_response.message,
                    )
                authorization = _authorization(spec.provider, auth_response.data)
                try:
                    await presenter.present(authorization)
                    await _wait_exact(client, authorization)
                except asyncio.CancelledError:
                    await asyncio.shield(_cancel_exact(client, authorization))
                    raise
                except ConnectionCancelled:
                    await _cancel_exact(client, authorization)
                    raise
                except BaseException:
                    await _cancel_exact(client, authorization)
                    raise

                refreshed_specs = await _list_connection_specs_with_client(client)
                refreshed = next(
                    (item for item in refreshed_specs if item.provider.lower() == wanted),
                    None,
                )
                if refreshed is None:
                    raise _error(spec.provider, ConnectionStage.CATALOG, "provider_disappeared")
                final = await _test_with_client(refreshed.provider, client)
                if final.ok is not True:
                    raise _error(
                        refreshed.provider,
                        ConnectionStage.VERIFICATION,
                        final.code or ("verification_unreachable" if final.ok is None else "verification_failed"),
                        final.detail,
                    )
                return ConnectionResult(spec=refreshed, test=final)
        except FlowServiceError as exc:
            raise _error(provider, ConnectionStage.SERVICE, exc.code, exc.detail) from exc
    finally:
        if provider_lock.is_locked:
            provider_lock.release()
