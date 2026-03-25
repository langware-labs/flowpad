import json
import os
from typing import Any
from urllib.parse import urlparse

import anyio
from httpx import AsyncClient

from .file_system import cwd_as_root_folder

_url_fetch_cache = {}

global_httpx_async_client = AsyncClient(http2=True)


async def fetch_url(url, cache_enabled=False):
    """
    Fetches a file from the provided local / remote url
    """
    global _url_fetch_cache
    if cache_enabled and url in _url_fetch_cache:
        return _url_fetch_cache[url]
    with cwd_as_root_folder():
        if os.path.exists(url):
            # Assume the url is a local file path starting from the root folder
            async with await anyio.open_file(url, mode="r") as file:
                content = await file.read()
                if cache_enabled:
                    _url_fetch_cache[url] = content
                return content
        else:
            response = await global_httpx_async_client.get(url)
            response.raise_for_status()
            content = response.text
            if cache_enabled:
                _url_fetch_cache[url] = content
            return content


async def fetch_json(url, cache_enabled=False) -> dict[str, Any]:
    """
    Fetches a JSON file from the provided local / remote url
    """
    return json.loads(await fetch_url(url, cache_enabled))


def is_url(maybe_url: str) -> bool:
    parsed = urlparse(maybe_url)
    return parsed.scheme in ("http", "https", "ftp") and parsed.netloc != ""
