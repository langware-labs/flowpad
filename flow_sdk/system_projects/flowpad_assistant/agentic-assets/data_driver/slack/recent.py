"""What happened on Slack lately, read with this machine's own Slack connection.

The token never leaves this process: the caller gets channel names and message lines, which is what an agent
asked to "summarize the last 24 hours on Slack" needs. Channels are the ones the connected account is a member
of; each is read once, in parallel, newest first, capped so one busy workspace cannot take minutes.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

SLACK_API = "https://slack.com/api"
#: Channels read at most (the most recently active first).
MAX_CHANNELS = 30
#: Messages kept per channel.
MAX_MESSAGES = 50
PARALLEL = 6


class SlackNotConnected(LookupError):
    """This machine holds no Slack connection (the machinery answers 409 for a ``LookupError``)."""


async def _token() -> str:
    from flow_sdk.core.oauth.provider_probe import token_from_credential  # noqa: PLC0415
    from flow_sdk.core.oauth.provider_registry import credential_for  # noqa: PLC0415

    token = token_from_credential(await credential_for("slack"))
    if not token:
        raise SlackNotConnected("Slack is not connected on this machine")
    return token


async def recent(hours: float = 24.0) -> dict[str, Any]:
    """``{"hours", "channels": [{"name", "messages": [{"user", "text", "ts"}]}], "users": {id: name}}`` for every
    channel with activity in the last ``hours``."""
    import httpx  # noqa: PLC0415

    token = await _token()
    oldest = time.time() - hours * 3600
    headers = {"Authorization": f"Bearer {token}"}
    async with httpx.AsyncClient(base_url=SLACK_API, headers=headers, timeout=20.0) as client:

        async def call(method: str, **params: Any) -> dict:
            resp = await client.get(f"/{method}", params=params)
            body = resp.json() if resp.content else {}
            if not body.get("ok"):
                raise RuntimeError(f"Slack {method}: {body.get('error') or resp.status_code}")
            return body

        listed = await call(
            "users.conversations", types="public_channel,private_channel", exclude_archived="true", limit=200
        )
        channels = list(listed.get("channels") or [])
        channels.sort(key=lambda c: float(c.get("updated") or 0), reverse=True)
        gate = asyncio.Semaphore(PARALLEL)

        async def history(channel: dict) -> dict | None:
            async with gate:
                try:
                    body = await call("conversations.history", channel=channel["id"], oldest=f"{oldest:.6f}", limit=MAX_MESSAGES)
                except RuntimeError:
                    return None  # one unreadable channel does not sink the summary
            messages = [
                {"user": m.get("user") or m.get("username") or m.get("bot_id") or "", "text": m.get("text") or "",
                 "ts": m.get("ts")}
                for m in body.get("messages") or []
                if not m.get("subtype") or m.get("subtype") in ("bot_message", "thread_broadcast")
            ]
            return {"name": channel.get("name") or channel["id"], "messages": messages[::-1]} if messages else None

        read = [c for c in await asyncio.gather(*(history(c) for c in channels[:MAX_CHANNELS])) if c]
        ids = sorted({m["user"] for c in read for m in c["messages"] if m["user"].startswith("U")})
        users: dict[str, str] = {}

        async def name(uid: str) -> None:
            async with gate:
                try:
                    info = (await call("users.info", user=uid)).get("user") or {}
                    users[uid] = info.get("real_name") or info.get("name") or uid
                except RuntimeError:
                    users[uid] = uid

        await asyncio.gather(*(name(u) for u in ids[:100]))
    return {"hours": hours, "channels": read, "users": users}
