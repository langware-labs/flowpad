import json
import os
from typing import Any
from urllib.parse import urlparse

import anyio
from httpx import AsyncClient

from .file_system import cwd_as_root_folder

global_httpx_async_client = AsyncClient(http2=True)


async def fetch_url(url):
    """
    Fetches a file from the provided local / remote url
    """
    with cwd_as_root_folder():
        if os.path.exists(url):
            # Assume the url is a local file path starting from the root folder
            async with await anyio.open_file(url, mode="r") as file:
                return await file.read()
        else:
            response = await global_httpx_async_client.get(url)
            response.raise_for_status()
            return response.text


async def fetch_json(url) -> dict[str, Any]:
    """
    Fetches a JSON file from the provided local / remote url
    """
    return json.loads(await fetch_url(url))


def is_url(maybe_url: str) -> bool:
    parsed = urlparse(maybe_url)
    return parsed.scheme in ("http", "https", "ftp") and parsed.netloc != ""
