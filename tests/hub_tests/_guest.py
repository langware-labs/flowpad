"""The GUEST side of a two-identity hub test: a DISTINCT hub account driven by
raw HTTP, and the prompt-completion selector both sides assert on.

``BOB_EMAIL``/``BOB_PW`` name the guest; the flowpad-app checkout's
``.env.local`` is the fallback so the same rig runs unconfigured on a dev box.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import NamedTuple

import httpx
import pytest

from flow_sdk.builtin.flow_message import AttachmentType, FlowMessage
from flow_sdk.builtin.prompt_completion import PromptCompletion

REPO_APP = Path(__file__).resolve().parents[2].parent / "flowpad-app"


def read_env_local(repo: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    path = repo / ".env.local"
    if not path.exists():
        return out
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


class Guest(NamedTuple):
    token: str
    email: str
    user_id: str

    @property
    def headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"}


async def guest_login(hub_base_url: str, client: httpx.AsyncClient | None = None) -> Guest:
    """Log the guest in; skip when no guest credentials are configured."""
    app_env = read_env_local(REPO_APP)
    email = os.environ.get("BOB_EMAIL") or app_env.get("FLOWPAD_CLOUD_USER_EMAIL")
    pw = os.environ.get("BOB_PW") or app_env.get("FLOWPAD_CLOUD_USER_PASSWORD")
    if not email or not pw:
        pytest.skip("missing BOB_EMAIL/BOB_PW and flowpad-app fallback credentials")

    async def _login(h: httpx.AsyncClient) -> dict:
        r = await h.post(f"{hub_base_url}/api/v1/login", json={"email": email, "password": pw})
        r.raise_for_status()
        return r.json()["data"]

    if client is not None:
        data = await _login(client)
    else:
        async with httpx.AsyncClient(timeout=5.0) as h:
            data = await _login(h)
    return Guest(data.get("api_key") or data["token"], email, (data.get("user") or {})["id"])


def completions(fms: list[FlowMessage]) -> list[FlowMessage]:
    """The prompt-completion replies among ``fms``."""
    return [
        m
        for m in fms
        if any(
            a.attachment_type == AttachmentType.TYPE_ID and (a.data or "").startswith(f"{PromptCompletion.get_type()}-")
            for a in (m.attachment or [])
        )
    ]
