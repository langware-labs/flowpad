"""Docker compute provider — spawns PTYs inside Docker containers via a reverse WS bridge."""

from .provider import DockerComputeProvider

__all__ = ["DockerComputeProvider"]
