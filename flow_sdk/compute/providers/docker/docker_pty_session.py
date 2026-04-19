"""DockerPtySession — PTY handle for DockerComputeProvider."""
from __future__ import annotations

from typing import TYPE_CHECKING

from flow_sdk.compute.providers.base_pty_session import PtySession

if TYPE_CHECKING:
    from .provider import DockerComputeProvider


class DockerPtySession(PtySession):
    _provider: "DockerComputeProvider"