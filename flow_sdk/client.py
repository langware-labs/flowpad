"""Flowpad API Client"""

import os
from typing import Any, Dict, Optional

import httpx
from pydantic import BaseModel, Field


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
        super().__init__(
            api_base_url=api_base_url or os.environ.get("API_BASE_URL", "https://app.flowpad.ai/api/v1"),
            login_url=login_url or os.environ.get("LOGIN_URL", "/login?target_path={redirect_url}"),
            logout_url=logout_url or os.environ.get("LOGOUT_URL", "/logout?returnTo={return_url}"),
        )

    @classmethod
    def from_env(cls) -> "ApiConfig":
        """Create ApiConfig from environment variables"""
        return cls()

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

    def __init__(self, config: ApiConfig):
        """
        Initialize the Flowpad API client.

        Args:
            config: API configuration
        """
        self.config = config
        self._api_key: Optional[str] = None
        self._client: Optional[httpx.AsyncClient] = None

    def set_api_key(self, api_key: str):
        """
        Set the API key for authentication.

        Args:
            api_key: The API key to use for requests
        """
        self._api_key = api_key

    def _get_headers(self) -> Dict[str, str]:
        """Get headers including Bearer auth if API key is set"""
        headers = {
            "Content-Type": "application/json",
        }

        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"

        return headers

    async def _get_client(self) -> httpx.AsyncClient:
        """Get or create the async HTTP client"""
        if self._client is None:
            self._client = httpx.AsyncClient(
                base_url=self.config.api_base_url, headers=self._get_headers(), timeout=30.0
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

    async def get(self, path: str) -> Any:
        """Make a GET request and return the unwrapped response data."""
        client = await self._get_client()
        return self._unwrap(await client.get(path))

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

    async def post(self, path: str, data: Dict[str, Any]) -> Any:
        """Make a POST request and return the unwrapped response data."""
        client = await self._get_client()
        return self._unwrap(await client.post(path, json=data))

    async def __aenter__(self):
        """Async context manager entry"""
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Async context manager exit"""
        await self.close()
