"""
HTTP reporter - forwards hook events to a remote server.
"""

import asyncio
from typing import Dict, Any, Optional
import aiohttp
from .base import BaseReporter


class HttpReporter(BaseReporter):
    """
    Reporter that forwards hook events to a remote HTTP server.

    Features:
    - Configurable target URL and headers
    - Async HTTP client for non-blocking requests
    - Configurable timeout
    - Optional retry logic
    - Silently handles failures to avoid blocking
    """

    def __init__(
        self,
        url: str,
        headers: Optional[Dict[str, str]] = None,
        timeout: float = 5.0,
        retry_count: int = 0,
    ):
        """
        Initialize the HTTP reporter.

        Args:
            url: Target URL to POST hook events to
            headers: Optional headers to include in requests
            timeout: Request timeout in seconds (default: 5.0)
            retry_count: Number of retries on failure (default: 0)
        """
        self._url = url
        self._headers = headers or {}
        self._timeout = timeout
        self._retry_count = retry_count
        self._session: Optional[aiohttp.ClientSession] = None

    async def _get_session(self) -> aiohttp.ClientSession:
        """Get or create the aiohttp session."""
        if self._session is None or self._session.closed:
            timeout = aiohttp.ClientTimeout(total=self._timeout)
            self._session = aiohttp.ClientSession(timeout=timeout)
        return self._session

    async def report(self, event: Dict[str, Any]) -> None:
        """
        Forward event to the remote server.

        Args:
            event: Hook event data dictionary
        """
        attempts = self._retry_count + 1

        for attempt in range(attempts):
            try:
                session = await self._get_session()
                async with session.post(
                    self._url,
                    json=event,
                    headers=self._headers,
                ) as response:
                    # Consider 2xx as success
                    if 200 <= response.status < 300:
                        return
                    # Log error but don't raise (silent failure)
                    if attempt == attempts - 1:
                        print(f"HttpReporter: server returned {response.status}")
            except asyncio.TimeoutError:
                if attempt == attempts - 1:
                    print(f"HttpReporter: request timed out after {self._timeout}s")
            except aiohttp.ClientError as e:
                if attempt == attempts - 1:
                    print(f"HttpReporter: connection error - {e}")
            except Exception as e:
                if attempt == attempts - 1:
                    print(f"HttpReporter: unexpected error - {e}")

    async def get_recent(self) -> list:
        """
        HTTP reporter doesn't store events locally.

        Returns:
            Empty list (HTTP reporter forwards, doesn't store)
        """
        return []

    async def cleanup(self) -> None:
        """Close the HTTP session."""
        if self._session and not self._session.closed:
            await self._session.close()
            self._session = None

    @property
    def url(self) -> str:
        """Get the target URL."""
        return self._url

    @url.setter
    def url(self, value: str) -> None:
        """Set the target URL."""
        self._url = value

    def set_header(self, key: str, value: str) -> None:
        """
        Set a header for requests.

        Args:
            key: Header name
            value: Header value
        """
        self._headers[key] = value

    def remove_header(self, key: str) -> None:
        """
        Remove a header.

        Args:
            key: Header name to remove
        """
        self._headers.pop(key, None)
