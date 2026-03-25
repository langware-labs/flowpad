"""Claude API rate-limit usage collector.

Fetches usage data from the Anthropic oauth/usage endpoint using the stored
Claude Code credentials. Results are cached in-process for 60 seconds to avoid
hammering the API on repeated scans.
"""

from __future__ import annotations

import asyncio
import logging
import time

logger = logging.getLogger(__name__)

_cache: dict = {}
_CACHE_TTL = 60  # seconds


async def _fetch_claude_usage_async() -> dict:
    """Fetch rate-limit usage from the Anthropic API (async)."""
    now = time.monotonic()
    if _cache.get("data") is not None and (now - _cache.get("ts", 0)) < _CACHE_TTL:
        return _cache["data"]

    try:
        from flow_sdk.builtin.faas.claude_code_auth import read_credentials

        creds = read_credentials()
    except Exception as exc:
        logger.debug("Could not read Claude credentials: %s", exc)
        return {}

    if not creds:
        return {}

    oauth = creds.get("claudeAiOauth") or {}
    token = oauth.get("accessToken")
    if not token:
        return {}

    try:
        import httpx

        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                "https://api.anthropic.com/api/oauth/usage",
                headers={
                    "Authorization": f"Bearer {token}",
                    "anthropic-beta": "oauth-2025-04-20",
                    "User-Agent": "claude-code/2.1.34",
                },
            )
    except Exception as exc:
        logger.debug("Failed to fetch Claude usage: %s", exc)
        return {}

    # On 401 (expired token), don't attempt refresh here.
    # Claude Code manages its own token lifecycle (via Keychain on macOS).
    # Consuming the single-use refresh token would invalidate Claude Code's
    # copy and force the user to re-login.
    if resp.status_code != 200:
        logger.debug("Claude usage API returned %s", resp.status_code)
        return {}

    data = resp.json()
    _cache["data"] = data
    _cache["ts"] = now
    return data


def get_claude_usage_sync() -> dict:
    """Synchronous wrapper for use inside a thread-pool executor.

    Always creates a fresh event loop so it's safe to call from a worker thread
    even when the main asyncio event loop is already running.
    """
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(_fetch_claude_usage_async())
    finally:
        loop.close()
