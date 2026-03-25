"""Shared pytest fixtures and utilities for Flow SDK testing."""

import asyncio
import json
import logging
import re
from pathlib import Path
from typing import Any, Dict, List

from flow_sdk.core.flow.models.flow_data import FlowData, ViewType
from flow_sdk.core.flow.streaming.response_handler import (
    CallbackHandler,
    StreamingResponseHandler,
)


# JSON utility for type-safe serialization
def type_safe_json(obj: Any) -> Dict[str, Any]:
    """Convert objects to JSON-serializable format."""
    if isinstance(obj, dict):
        return {k: type_safe_json(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [type_safe_json(item) for item in obj]
    elif hasattr(obj, "model_dump"):
        return type_safe_json(obj.model_dump())
    elif hasattr(obj, "__dict__"):
        return type_safe_json(obj.__dict__)
    else:
        return obj


# JSON utilities
def clean_json(json_data: dict) -> dict:
    """Remove common metadata keys from JSON data."""
    keys_to_remove = {"key", "version", "namespace", "created_date", "created_by", "updated_by", "updated_date"}
    return remove_keys_from_data(json_data, keys_to_remove)


def remove_keys_from_data(data, keys_to_remove):
    """Recursively remove specified keys from data structures."""
    if isinstance(data, dict):
        return {k: remove_keys_from_data(v, keys_to_remove) for k, v in data.items() if k not in keys_to_remove}
    elif isinstance(data, list):
        return [remove_keys_from_data(item, keys_to_remove) for item in data]
    else:
        return data


def sort_json(json_obj):
    """Recursively sort JSON objects and lists."""
    if isinstance(json_obj, dict):
        return {k: sort_json(v) for k, v in sorted(json_obj.items())}
    if isinstance(json_obj, list):
        return [sort_json(item) for item in json_obj]
    return json_obj


# File system utilities
class FolderDriver:
    """File system driver for test file operations."""

    def __init__(self, root: str):
        """Initialize with root directory."""
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def write_file(self, relative_path: str, content: str):
        """Write content to a file."""
        full_path = self.root / relative_path
        full_path.parent.mkdir(parents=True, exist_ok=True)
        with open(full_path, "w", encoding="utf-8") as f:
            f.write(content)

    def read_file(self, relative_path: str) -> str:
        """Read file content."""
        full_path = self.root / relative_path
        if not full_path.exists():
            raise FileNotFoundError(f"File not found: {full_path}")
        return full_path.read_text(encoding="utf-8")

    def exists(self, relative_path: str) -> bool:
        """Check if file exists."""
        return (self.root / relative_path).exists()

    def delete_file(self, relative_path: str):
        """Delete a file."""
        full_path = self.root / relative_path
        if full_path.exists():
            full_path.unlink()


# Unified Test Callback Handlers


class UnifiedTestCallbackHandler(CallbackHandler):
    """
    Unified callback handler for flow testing.

    Features:
    - Full event tracking (user messages, status, focus, errors)
    - Completion and error state tracking
    - Configurable verbosity levels
    """

    def __init__(self, verbose: bool = True, track_all_events: bool = True):
        """Initialize the unified test callback handler."""
        self.verbose = verbose
        self.track_all_events = track_all_events

        # Core event tracking (always available)
        self.events: List[Dict[str, Any]] = []
        self.errors: List[Exception] = []
        self.completed = False

        # Detailed tracking (enabled by verbose)
        self.status_messages: List[str] = []
        self.user_messages: List[str] = []
        self.focus_events: List[Dict[str, Any]] = []
        self.error_messages: List[str] = []
        self.ux_messages: List[str] = []

        # State tracking
        self.focus_calls: Dict[str, Any] = {}
        self.state_calls: Dict[str, Any] = {}

    async def on_user_message(self, message: str):
        """Track user messages."""
        if self.verbose:
            self.user_messages.append(message)
        if self.track_all_events:
            self.events.append({"type": "user_message", "message": message})

    async def on_status(self, message: str):
        """Track status messages."""
        if self.verbose:
            self.status_messages.append(message)
        if self.track_all_events:
            self.events.append({"type": "status", "message": message})

    async def on_focus(self, focus_type: ViewType, data: dict = None):
        """Track focus events."""
        focus_event = {"type": focus_type, "data": data}
        if self.verbose:
            self.focus_events.append(focus_event)
            self.focus_calls[focus_type] = data
        if self.track_all_events:
            self.events.append({"type": "focus", "focus_type": focus_type, "data": data})

    async def on_state(self, key: str, data: Any):
        """Track state changes."""
        if self.verbose:
            self.state_calls[key] = data
        if self.track_all_events:
            self.events.append({"type": "state", "key": key, "data": data})

    async def on_error(self, error: Exception):
        """Track errors."""
        self.errors.append(error)
        if self.verbose:
            self.error_messages.append(str(error))
        if self.track_all_events:
            self.events.append({"type": "error", "error": str(error)})

    async def on_ux_message(self, message: str):
        """Track UX messages."""
        if self.verbose:
            self.ux_messages.append(message)
        if self.track_all_events:
            self.events.append({"type": "ux_message", "message": message})

    async def on_end(self):
        """Mark as completed."""
        self.completed = True
        if self.track_all_events:
            self.events.append({"type": "end"})

    # Utility methods

    def has_errors(self) -> bool:
        """Check if any errors occurred."""
        return len(self.errors) > 0

    def get_last_status(self) -> str:
        """Get the most recent status message."""
        return self.status_messages[-1] if self.status_messages else ""

    def get_focus_calls_by_type(self, focus_type: str) -> Any:
        """Get focus calls by type."""
        return self.focus_calls.get(focus_type)

    def get_state_by_key(self, key: str) -> Any:
        """Get state data by key."""
        return self.state_calls.get(key)

    def get_events_by_type(self, event_type: str) -> List[Dict[str, Any]]:
        """Get all events of a specific type."""
        return [event for event in self.events if event.get("type") == event_type]

    def reset(self):
        """Reset all tracked data for reuse."""
        self.events.clear()
        self.errors.clear()
        self.completed = False
        self.status_messages.clear()
        self.user_messages.clear()
        self.focus_events.clear()
        self.error_messages.clear()
        self.ux_messages.clear()
        self.focus_calls.clear()
        self.state_calls.clear()


class UnifiedStreamingTestCallbackHandler(StreamingResponseHandler):
    """
    Unified streaming callback handler for tests requiring streaming functionality.
    """

    def __init__(self, verbose: bool = True):
        """Initialize the streaming test callback handler."""
        super().__init__()
        self.verbose = verbose

        # Core tracking
        self.errors: List[Exception] = []
        self.completed = False
        self.focus_calls: Dict[str, Any] = {}
        self.state_calls: Dict[str, Any] = {}
        self.ux_messages: List[str] = []

        # FlowData result tracking
        self.flow_data_list: List[FlowData] = []

    async def on_focus(
        self,
        focus: ViewType,
        args: dict[str, str] | None = None,
    ):
        """Track focus events."""
        self.focus_calls[focus] = args
        await super().on_focus(focus, args)

    async def on_state(self, key: str, data: Any):
        """Track state changes."""
        self.state_calls[key] = data
        await super().on_state(key, data)

    async def on_ux_message(self, message: str):
        """Track UX messages."""
        if self.verbose:
            self.ux_messages.append(message)
        await super().on_ux_message(message)

    async def on_error(self, error: Exception):
        """Track errors."""
        self.errors.append(error)
        await super().on_error(error)

    async def on_end(self):
        """Mark as completed."""
        self.completed = True
        await super().on_end()

    def has_errors(self) -> bool:
        """Check if any errors occurred."""
        return len(self.errors) > 0

    def get_focus_calls_by_type(self, focus_type: str) -> Any:
        """Get focus calls by type."""
        return self.focus_calls.get(focus_type)

    def get_state_by_key(self, key: str) -> Any:
        """Get state data by key."""
        return self.state_calls.get(key)

    def get_flow_data_list(self) -> List[FlowData]:
        """Get all captured FlowData results."""
        return self.flow_data_list.copy()

    def get_result_count(self) -> int:
        """Get count of captured FlowData results."""
        return len(self.flow_data_list)

    def get_first_result(self) -> FlowData | None:
        """Get first captured FlowData result, or None if none captured."""
        return self.flow_data_list[0] if self.flow_data_list else None

    async def on_flow_data(self, flow_data: FlowData | None):
        """Track FlowData."""
        if flow_data is not None:
            self.flow_data_list.append(flow_data)
        await super().on_flow_data(flow_data)

    def mock(self, flow_data_list: List[FlowData]):
        """Inject mock FlowData list for testing."""
        self._mock_data = flow_data_list.copy()
        self._mock_data.append(None)
        self._mock_index = 0
        # Process mock data asynchronously
        asyncio.create_task(self._process_mock_data())

    async def _process_mock_data(self):
        """Process mock data through on_flow_data."""
        if not self._mock_data:
            return

        for flow_data in self._mock_data:
            await self.on_flow_data(flow_data)

        # Signal completion
        await self.on_end()


class SimpleDebugCallbackHandler(CallbackHandler):
    """Simple callback handler for debug tests with minimal tracking."""

    def __init__(self):
        """Initialize the debug callback handler."""
        self.events = []
        self.status_messages = []
        self.focus_events = []
        self.user_messages = []
        self.error_messages = []

    async def on_user_message(self, message: str):
        """Track user messages."""
        self.user_messages.append(message)
        self.events.append({"type": "user_message", "message": message})

    async def on_status(self, message: str):
        """Track status messages."""
        self.status_messages.append(message)
        self.events.append({"type": "status", "message": message})

    async def on_focus(self, focus_type: str, data: dict = None):
        """Track focus events."""
        focus_event = {"type": focus_type, "data": data}
        self.focus_events.append(focus_event)
        self.events.append({"type": "focus", "focus_type": focus_type, "data": data})

    async def on_error(self, error: Exception):
        """Track errors."""
        self.error_messages.append(str(error))
        self.events.append({"type": "error", "error": str(error)})

    async def on_end(self):
        """Mark as completed."""
        self.events.append({"type": "end"})


# Alias for backward compatibility
DebugCallbackHandler = SimpleDebugCallbackHandler


# Factory functions for common test scenarios


def create_debug_callback_handler(verbose: bool = True) -> UnifiedTestCallbackHandler:
    """Create a callback handler optimized for debug testing."""
    return UnifiedTestCallbackHandler(verbose=verbose, track_all_events=True)


def create_minimal_callback_handler() -> UnifiedTestCallbackHandler:
    """Create a minimal callback handler that only tracks essential events."""
    return UnifiedTestCallbackHandler(verbose=False, track_all_events=False)


def create_streaming_callback_handler(verbose: bool = True) -> UnifiedStreamingTestCallbackHandler:
    """Create a streaming callback handler for streaming response tests."""
    return UnifiedStreamingTestCallbackHandler(verbose=verbose)


class XMLStreamParser:
    """
    Parser for converting XML chunks back into FlowData objects.
    Handles partial chunks and reassembles them into complete FlowData items.
    """

    def __init__(self):
        self._buffer = ""
        self._current_element = None
        self._current_content = []
        self._queue: asyncio.Queue = asyncio.Queue()

    async def feed(self, chunk: str | None):
        """Feed a chunk of XML to the parser."""
        if chunk is None:
            # End of stream
            await self._flush_buffer()
            await self._queue.put(None)
            return

        self._buffer += chunk
        await self._process_buffer()

    async def cleanup(self):
        """Signal end of stream to the parser."""
        await self.feed(None)

    async def run(self, handler):
        """Run the parser on a streaming handler, feeding all chunks and cleaning up."""
        async for chunk in handler:
            await self.feed(chunk)
        await self.cleanup()

    async def _process_buffer(self):
        """Process buffered content to extract complete XML elements."""
        while self._buffer:
            # Look for complete XML elements
            # Pattern: <flow-TYPE ...>CONTENT</flow-TYPE>
            match = re.match(r"<flow-([a-z-]+)([^>]*)>(.*?)</flow-\1>\n", self._buffer, re.DOTALL)

            if not match:
                # No complete element found, wait for more data
                break

            # Extract the complete element
            full_match = match.group(0)
            element_type = match.group(1)
            attributes_str = match.group(2)
            content = match.group(3)

            # Parse attributes
            attributes = {}
            if attributes_str:
                attr_matches = re.findall(r'([\w-]+)="([^"]*)"', attributes_str)
                for key, value in attr_matches:
                    if key != "i":  # Skip index attribute
                        attributes[key] = value

            # Add element-type back
            attributes["element-type"] = element_type

            # Ensure data-type is set correctly (it may be missing from old attributes)
            if "data-type" not in attributes:
                attributes["data-type"] = "string"

            # Determine data type and parse content accordingly
            data_type = attributes.get("data-type", "string")

            if data_type == "object":
                # Try to parse JSON content
                try:
                    flow_value = json.loads(content)
                except json.JSONDecodeError:
                    # If it's not valid JSON, keep it as a string
                    flow_value = content
            else:
                # Keep as string
                flow_value = content

            # Create FlowData
            flow_data = FlowData(flow_value=flow_value, attributes=attributes)

            # Add to queue
            await self._queue.put(flow_data)

            # Remove processed element from buffer
            self._buffer = self._buffer[len(full_match) :]

    async def _flush_buffer(self):
        """Process any remaining content in the buffer."""
        if self._buffer.strip():
            # Try one more time to process
            await self._process_buffer()

    def __aiter__(self):
        """Make the parser an async iterator."""
        return self

    async def __anext__(self) -> FlowData | None:
        """Get the next FlowData item from the queue."""
        item = await self._queue.get()
        if item is None:
            raise StopAsyncIteration
        return item
