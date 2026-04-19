"""E2BPtySession — PTY handle for E2BComputeProvider."""
from __future__ import annotations

from typing import TYPE_CHECKING

from flow_sdk.compute.providers.base_pty_session import PtySession

if TYPE_CHECKING:
    from .provider import E2BComputeProvider


class E2BPtySession(PtySession):
    _provider: "E2BComputeProvider"