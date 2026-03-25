"""
Base reporter interface for hook events.
"""

from abc import ABC, abstractmethod
from typing import Dict, Any


class BaseReporter(ABC):
    """
    Abstract base class for hook event reporters.

    Reporters receive hook events and handle them in different ways
    (e.g., storing in buffer, broadcasting to WebSocket clients, etc.)
    """

    @abstractmethod
    async def report(self, event: Dict[str, Any]) -> None:
        """
        Handle a hook event.

        Args:
            event: Hook event data dictionary
        """
        pass

    @abstractmethod
    async def get_recent(self) -> list:
        """
        Get recent events (if supported by reporter).

        Returns:
            List of recent events, or empty list if not supported
        """
        pass

    async def cleanup(self) -> None:
        """
        Cleanup resources. Override if needed.
        """
        pass
