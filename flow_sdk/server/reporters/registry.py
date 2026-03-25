"""
Reporter registry - manages active reporters.
"""

from typing import List, Dict, Any
from .base import BaseReporter


class ReporterRegistry:
    """
    Manages a list of active reporters.

    The /api/hooks/report endpoint uses this registry to broadcast
    events to all active reporters.
    """

    def __init__(self):
        """Initialize the registry with no reporters."""
        self._reporters: List[BaseReporter] = []

    def add(self, reporter: BaseReporter) -> None:
        """Add a reporter to the registry."""
        if reporter not in self._reporters:
            self._reporters.append(reporter)

    def remove(self, reporter: BaseReporter) -> None:
        """Remove a reporter from the registry."""
        if reporter in self._reporters:
            self._reporters.remove(reporter)

    async def report_all(self, event: Dict[str, Any]) -> None:
        """Broadcast event to all registered reporters."""
        for reporter in self._reporters:
            try:
                await reporter.report(event)
            except Exception as e:
                # Log but don't fail on individual reporter errors
                print(f"Reporter error: {e}")

    @property
    def reporters(self) -> List[BaseReporter]:
        """Get list of active reporters."""
        return self._reporters.copy()

    def clear(self) -> None:
        """Remove all reporters."""
        self._reporters.clear()
