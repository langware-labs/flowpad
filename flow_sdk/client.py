
"""Flowpad API Client"""

import os
from typing import Optional, Dict, Any
from pydantic import BaseModel, Field
import httpx


class ApiConfig(BaseModel):
    """API configuration model"""

    api_base_url: str = Field(default="https://flowpad.ai/api/v1")
    login_url: str = Field(default="/login?target_path={redirect_url}")

    def __init__(self, **data: Any):
        super().__init__(**data)
        self.api_base_url = os.environ.get("API_BASE_URL", "https://flowpad.ai/api/v1")
        self.login_url = os.environ.get("LOGIN_URL", "/login?target_path={redirect_url}")

    @classmethod
    def from_env(cls) -> "ApiConfig":
        """Create ApiConfig from environment variables"""
        api_base_url = os.environ.get("API_BASE_URL", "https://flowpad.ai/api/v1")
        login_url = os.environ.get("LOGIN_URL", "/login?target_path={redirect_url}")

        return cls(
            api_base_url=api_base_url,
            login_url=login_url
        )

    def get_full_login_url(self) -> str:
        """Get the full login URL by combining base URL with login path"""
        # If login_url is absolute (starts with http), return as-is
        if self.login_url.startswith("http"):
            return self.login_url

        # Otherwise, combine with api_base_url
        return f"{self.api_base_url}{self.login_url}"


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
                base_url=self.config.api_base_url,
                headers=self._get_headers(),
                timeout=30.0
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

    async def get_user(self) -> Dict[str, Any]:
        """
        Get the current user information.

        Returns:
            User data as a dictionary

        Raises:
            httpx.HTTPStatusError: If the request fails
            ValueError: If the response is not valid JSON or missing 'id'
        """
        client = await self._get_client()

        response = await client.get("/current-user")

        # Check status code
        if response.status_code != 200:
            raise ValueError(f"API returned status {response.status_code}: {response.text}")

        # Parse JSON response
        try:
            response_data = response.json()
        except Exception as e:
            raise ValueError(f"Failed to parse JSON response: {response.text}")
        if "status" in response_data and str(response_data["status"]).lower() != "success":
            raise ValueError(f"API returned error status: {response_data}")
        # Check if response has a 'data' property (wrapped response)
        if "data" in response_data:
            user_data = response_data["data"]
        else:
            user_data = response_data

        # Validate that response has 'id' field
        if "id" not in user_data:
            import json
            formatted_json = json.dumps(response_data, indent=2)
            raise ValueError(f"Invalid user data: missing 'id' field. Got response:\n{formatted_json}")

        return user_data

    async def __aenter__(self):
        """Async context manager entry"""
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Async context manager exit"""
        await self.close()
