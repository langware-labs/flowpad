"""LocalPtySession — PTY handle for LocalComputeProvider."""
from __future__ import annotations

from typing import TYPE_CHECKING

from flow_sdk.compute.providers.base_pty_state import PtySession

if TYPE_CHECKING:
    from .provider import LocalComputeProvider


class LocalPtySession(PtySession):
    _provider: "LocalComputeProvider"