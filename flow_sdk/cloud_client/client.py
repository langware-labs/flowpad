"""Flowpad API Client"""

import os
from typing import Any, Dict, Optional

import httpx
from pydantic import BaseModel, Field

from flow_sdk.cloud_client.client_hooks import HubAuthExpiredError, build_event_hooks, request_path
from flow_sdk.cloud_client.error_reporter import hub_error_reporter
from flow_sdk.config import API_PREFIX, FLOWPAD_CLOUD_URL, default_service_config


class ApiConfig(BaseModel):
    """API configuration model"""

    api_base_url: Optional[str] = Field(default=None)
    login_url: Optional[str] = Field(default=None)
    logout_url: Optional[str] = Field(default=None)

    def __init__(
        self,
        api_base_url: Optional[str] = None,
        login_url: Optional[str] = None,
        logout_url: Optional[str] = None,
    ):
        hub_url = default_service_config.flowpad_hub_url or FLOWPAD_CLOUD_URL
        super().__init__(
            api_base_url=api_base_url or f"{hub_url.rstrip('/')}{API_PREFIX}",
            login_url=login_url or os.environ.get("LOGIN_URL", "/login?target_path={redirect_url}"),
            logout_url=logout_url or os.environ.get("LOGOUT_URL", "/logout?returnTo={return_url}"),
        )

    @classmethod
    def from_env(cls) -> "ApiConfig":
        """Create ApiConfig from environment variables"""
        return cls()

    @property
    def app_base_url(self) -> Optional[str]:
        """Hub browser-app origin corresponding to :attr:`api_base_url`.

        ``FLOWPAD_HUB_URL`` names the Hub application.  ``ApiConfig`` appends
        ``/api/v1`` for API traffic; browser links must use the application
        origin instead of accidentally nesting dock routes below the API
        prefix.  Explicit ``api_base_url`` values retain the same contract.
        """
        explicit_web_url = os.environ.get("FLOWPAD_HUB_WEB_URL", "").strip()
        if explicit_web_url:
            return explicit_web_url.rstrip("/")
        if not self.api_base_url:
            return None
        normalized = self.api_base_url.rstrip("/")
        return normalized[: -len(API_PREFIX)] if normalized.endswith(API_PREFIX) else normalized

    def _get_full_url(self, path: Optional[str]) -> str:
        """Combine api_base_url with a relative path, or return as-is if absolute."""
        if not path:
            return self.api_base_url or ""
        if path.startswith("http"):
            return path
        return f"{self.api_base_url}{path}"

    def get_full_login_url(self) -> str:
        """Get the full login URL by combining base URL with login path"""
        return self._get_full_url(self.login_url)

    def get_full_logout_url(self) -> str:
        """Get the full logout URL by combining base URL with logout path"""
        return self._get_full_url(self.logout_url)


class FlowpadClient:
    """Async HTTP client for Flowpad API"""

    def __init__(
        self,
        config: ApiConfig,
        api_key: str | None = None,
        timeout: float | httpx.Timeout = 30.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        """
        Initialize the Flowpad API client.

        Args:
            config: API configuration
        """
        self.config = config
        self._api_key: Optional[str] = api_key
        self._client: Optional[httpx.AsyncClient] = None
        self._timeout = timeout
        self._transport = transport

    def set_api_key(self, api_key: str):
        """
        Set the API key for authentication.

        Args:
            api_key: The API key to use for requests
        """
        self._api_key = api_key

    def _get_headers(self) -> Dict[str, str]:
        """Get default headers. Auth is normally injected by request hooks."""
        headers = {
            "Accept": "application/json",
        }

        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"

        return headers

    async def _get_client(self) -> httpx.AsyncClient:
        """Get or create the async HTTP client"""
        if self._client is None:
            self._client = httpx.AsyncClient(
                base_url=self.config.api_base_url,
                headers=self._get_headers(),
                timeout=self._timeout,
                transport=self._transport,
                event_hooks=build_event_hooks(),
            )
        else:
            # Update headers in case API key changed
            self._client.headers.update(self._get_headers())

        return self._client

    async def close(self):
        """Close the HTTP client"""
        if self._client:
            await self._client.aclose()
            self._client = None

    def _unwrap(self, response: httpx.Response) -> Any:
        """Validate an API response and return its unwrapped ``data`` value.

        Raises:
            ValueError: On non-200 status, non-success envelope status, or
                unparseable JSON.
        """
        if response.status_code != 200:
            raise ValueError(f"API returned status {response.status_code}: {response.text}")
        try:
            response_data = response.json()
        except Exception:
            raise ValueError(f"Failed to parse JSON response: {response.text}")
        if "status" in response_data and str(response_data["status"]).lower() != "success":
            raise ValueError(f"API returned error status: {response_data}")
        return response_data["data"] if "data" in response_data else response_data

    async def request(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        params: dict[str, Any] | None = None,
        files: Any = None,
        content: Any = None,
        headers: dict[str, str] | None = None,
        timeout: float | httpx.Timeout | None = None,
    ) -> httpx.Response:
        """Make a raw HTTP request with hub hooks attached.

        ``content`` accepts raw bytes or an (async) byte iterator — used for
        streamed uploads where the body is produced incrementally so a
        progress callback can fire between chunks. ``headers`` merges over the
        client defaults (e.g. a hand-built ``multipart/form-data`` boundary).
        """
        client = await self._get_client()
        try:
            return await client.request(
                method,
                path,
                json=json,
                params=params,
                files=files,
                content=content,
                headers=headers,
                timeout=timeout,
            )
        except HubAuthExpiredError:
            raise
        except httpx.RequestError as e:
            await hub_error_reporter.report(
                status_code=0,
                method=method.upper(),
                path=self._request_path(e.request.url if e.request else path),
                message=str(e),
            )
            raise

    async def open_stream(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
        timeout: float | httpx.Timeout | None = None,
    ):
        """Return an httpx streaming-response context manager.

        For large downloads consumed chunk-by-chunk (``resp.aiter_bytes()``)
        instead of buffered whole into ``resp.content`` — lets a caller report
        download progress as bytes land. Usage::

            async with await client.open_stream("GET", url) as resp:
                async for chunk in resp.aiter_bytes():
                    ...
        """
        client = await self._get_client()
        return client.stream(method, path, params=params, headers=headers, timeout=timeout)

    @staticmethod
    def _request_path(url_or_path: Any) -> str:
        if isinstance(url_or_path, httpx.URL):
            return request_path(url_or_path)
        return str(url_or_path)

    async def get(
        self,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        raw: bool = False,
        timeout: float | httpx.Timeout | None = None,
    ) -> Any:
        """Make a GET request and return the unwrapped response data."""
        response = await self.request("GET", path, params=params, timeout=timeout)
        return response.content if raw else self._unwrap(response)

    async def get_user(self) -> Dict[str, Any]:
        """Get the current user information.

        Raises:
            ValueError: If the response is missing the 'id' field.
        """
        user_data = await self.get("/current-user")
        if "id" not in user_data:
            import json
            raise ValueError(f"Invalid user data: missing 'id' field. Got:\n{json.dumps(user_data, indent=2)}")
        return user_data

    async def post(
        self,
        path: str,
        data: Dict[str, Any] | None = None,
        *,
        files: Any = None,
        timeout: float | httpx.Timeout | None = None,
    ) -> Any:
        """Make a POST request and return the unwrapped response data."""
        response = await self.request(
            "POST",
            path,
            json=None if files else (data or {}),
            files=files,
            timeout=timeout,
        )
        return self._unwrap(response)

    async def put(
        self,
        path: str,
        data: Dict[str, Any] | None = None,
        *,
        timeout: float | httpx.Timeout | None = None,
    ) -> Any:
        """Make a PUT request and return the unwrapped response data."""
        response = await self.request("PUT", path, json=data or {}, timeout=timeout)
        return self._unwrap(response)

    async def __aenter__(self):
        """Async context manager entry"""
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Async context manager exit"""
        await self.close()
