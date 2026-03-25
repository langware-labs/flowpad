import asyncio
import logging
from typing import TYPE_CHECKING, Any, AsyncGenerator, Literal

from pydantic import BaseModel

from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowData, FlowDataType, FlowElementType, ViewType

if TYPE_CHECKING:
    from flow_sdk.shared import TraceItem


class QueueChunk(BaseModel):
    """Model for queue chunks with better control over push/pull operations."""

    model_config = {"arbitrary_types_allowed": True}

    data: str | Exception | None
    ux_message: bool = False
    delay_ms: float = 0.0


class CallbackHandler:
    async def on_user_message(self, message: str):
        """Called when a new user message is received."""
        raise NotImplementedError()

    async def on_flow_data(self, flow_data: FlowData):
        raise NotImplementedError()

    async def on_status(self, status: str):
        """Called when a new status is received."""
        raise NotImplementedError()

    async def on_ux_status(self, status: str, delay_ms: float = 1000.0):
        raise NotImplementedError()

    async def on_focus(
        self,
        focus: ViewType,
        args: dict[str, str] | None = None,
    ):
        """Called when a new focus is received."""
        raise NotImplementedError()

    async def on_new_sources(self, sources: list[str]):
        """Called when new sources are received."""
        raise NotImplementedError()

    async def on_trace(self, message: str, level: Literal["info", "warning", "error"] = "info"):
        """Called when a trace message is received (legacy)."""
        raise NotImplementedError()

    async def on_trace_item(self, trace: "TraceItem"):
        """Called when a full trace item is received."""
        raise NotImplementedError()

    async def on_shell_input(self, command: str, workdir: str):
        """Called when a shell input is received."""
        raise NotImplementedError()

    async def on_shell_output(self, content: str, channel: str):
        """Called when shell output (stdout/stderr) is received.

        Args:
            content: The shell output content
            channel: Either "stdout" or "stderr"
        """
        raise NotImplementedError()

    async def on_result(self, result: FlowData):
        """Called when a result is received."""
        raise NotImplementedError()

    async def on_new_chunk(self, chunk: str):
        """Called when a new chunk is received."""
        pass

    async def on_cached_message(self, cached_message: str):
        """Called when a cached message is received."""
        raise NotImplementedError()

    async def on_error(self, error: Exception):
        """Called when an error is received."""
        raise NotImplementedError()

    async def on_llm_end(self):
        """Called when the LLM has finished generating the response."""
        raise NotImplementedError()

    async def on_state(self, key: str, data: dict):
        """Called when flow state data is updated."""
        raise NotImplementedError()

    async def on_end(self):
        """Called when the response is finished."""
        raise NotImplementedError()

    async def on_reasoning(self, chunk: str):
        """Called when reasoning content is received."""
        raise NotImplementedError()

    async def on_chat(self, chunk: str):
        """Called when chat content is received."""
        raise NotImplementedError()


class IteratorCallbackHandler(CallbackHandler):
    """Callback handler for iterators that are updated based on the response."""

    def __init__(self):
        self.iterator = []
        self.sources = []

    def __iter__(self):
        return iter(self.iterator)

    async def on_new_sources(self, sources: list[str]):
        self.sources += sources

    async def on_new_chunk(self, chunk: str):
        if chunk:
            self.iterator += [chunk]

    async def on_cached_message(self, cached_message: str):
        self.iterator = [cached_message]

    async def on_end(self):
        """Called when the response is finished."""
        pass

    async def on_focus(self, focus, args=None):
        pass

    async def on_error(self, error: Exception):
        """Called when an error is received."""
        pass

    async def on_llm_end(self):
        """Called when the LLM has finished generating the response."""
        pass

    async def on_user_message(self, message: str):
        pass

    async def on_status(self, status: str):
        pass

    async def on_ux_status(self, status: str, delay_ms: float = 1000.0):
        pass

    async def on_state(self, key: str, data: dict):
        pass

    async def on_reasoning(self, chunk: str):
        pass

    async def on_chat(self, chunk: str):
        pass

    async def on_result(self, result: FlowData):
        pass

    async def on_shell_input(self, command: str, workdir: str):
        pass

    async def on_shell_output(self, chunk: str, channel: str):
        if chunk:
            self.iterator += [chunk]

    async def on_trace(self, message: str, level: Literal["info", "warning", "error"] = "info"):
        pass

    async def on_trace_item(self, trace: "TraceItem"):
        pass

    async def on_flow_data(self, flow_data: FlowData):
        pass


async def get_from_queues(*queues: asyncio.Queue, timeout: float | None = None) -> Any:
    """
    Return the next available item from the first non-empty queue among `queues`.
    Priority is the order of the arguments.
    If none are ready, wait on all; if a later queue produces first but an earlier one
    becomes ready by wake-up time, we still return from the earlier one and put the
    later queue's item back (so no one is harmed).

    Args:
        *queues: The queues to monitor
        timeout: Maximum time to wait in seconds. If None, wait indefinitely.

    Raises:
        asyncio.TimeoutError: If timeout is reached before any queue has data
    """
    if not queues:
        raise ValueError("Must provide at least one queue")

    # Fast path: prefer earliest non-empty queue without blocking
    for q in queues:
        try:
            return q.get_nowait()
        except asyncio.QueueEmpty:
            pass

    # Otherwise, race all of them
    tasks = [asyncio.create_task(q.get()) for q in queues]
    done, pending = await asyncio.wait(set(tasks), return_when=asyncio.FIRST_COMPLETED, timeout=timeout)

    if not done:
        # Timeout occurred - cancel all tasks and raise
        for t in tasks:
            t.cancel()
        raise asyncio.TimeoutError("Timeout waiting for queue data")

    winner_task = next(iter(done))
    winner_idx = tasks.index(winner_task)
    winner_item = winner_task.result()

    # Cancel the remaining get() calls (cancel-safe; doesn't consume anything)
    for t in pending:
        t.cancel()

    # STRICT priority: give earlier queues a final non-blocking chance
    for earlier_q in queues[:winner_idx]:
        try:
            earlier_item = earlier_q.get_nowait()
            # Put the winner back so nothing is lost
            queues[winner_idx].put_nowait(winner_item)
            return earlier_item
        except asyncio.QueueEmpty:
            continue

    return winner_item


class StreamingResponseHandler(CallbackHandler):
    def __init__(self):
        self._lock = asyncio.Lock()
        self._done = False
        self._queues: list[asyncio.Queue[QueueChunk | None]] = []  # Multi-consumer queues using QueueChunk

        self._history: str = ""
        self._ux_queue = asyncio.Queue[QueueChunk | None]()  # UX message queue
        self._current_status: str | None = "Thinking..."
        self._current_focus: ViewType = ViewType.CHAT
        self.sources = []
        self.current_streaming_flow_data: FlowData | None = None

    async def add_str_to_queue(
        self, data: str | Exception | None, ux_message: bool = False, delay_ms: float = 0.0
    ) -> None:
        """Helper function to add string data by creating FlowData and calling on_flow_data."""
        if ux_message:
            # Create UX chunk and add to UX queue
            chunk = QueueChunk(data=data, ux_message=ux_message, delay_ms=delay_ms)
            await self._ux_queue.put(chunk)
        else:
            # Convert to FlowData and use standard flow
            if data is None:
                await self.on_flow_data(None)
            else:
                flow_data = FlowData(flow_value=data, attributes={"element-type": "content", "data-type": "string"})
                await self.on_flow_data(flow_data)

    async def add_flow_data_to_queue(self, data: FlowData, ux_message: bool = False, delay_ms: float = 0.0) -> None:
        """Helper function to add FlowData."""
        if ux_message:
            # UX messages not supported for FlowData, convert to string
            chunk = QueueChunk(data=str(data.flow_value), ux_message=ux_message, delay_ms=delay_ms)
            await self._ux_queue.put(chunk)
        else:
            await self._broadcast(data)

    async def _clear_ux_queue(self) -> None:
        """Clear all messages from the UX queue."""
        cleared_count = 0
        while not self._ux_queue.empty():
            try:
                self._ux_queue.get_nowait()
                cleared_count += 1
            except Exception:
                break

        if cleared_count > 0:
            logging.debug(f"Cleared {cleared_count} UX message(s) from ux_queue")

    async def on_flow_data(self, flow_data: FlowData | None):
        if flow_data is None:
            await self._broadcast(None)
        else:
            await self.add_flow_data_to_queue(flow_data)

    async def on_user_message(self, message: str):
        flow_data = FlowData(
            flow_value=message,
            attributes={"element-type": FlowElementType.PROMPT_ECHO, "data-type": FlowDataType.TEXT},
        )
        await self.on_flow_data(flow_data)

    async def on_status(self, status: str):
        if status != self._current_status:
            flow_data = FlowData(
                flow_value=status, attributes={"element-type": FlowElementType.STATUS, "data-type": FlowDataType.TEXT}
            )
            await self.on_flow_data(flow_data)
            await self._clear_ux_queue()
            self._current_status = status

    async def on_ux_status(self, status: str, delay_ms: float = 1000.0):
        """Add a UX status message to the UX queue with configurable delay."""
        await self.add_str_to_queue(f"<flow-status>{status}</flow-status>", ux_message=True, delay_ms=delay_ms)
        return

    async def on_focus(
        self,
        focus: ViewType,
        args: dict[str, str] | None = None,
    ):
        if focus != self._current_focus:
            flow_data = FlowData(
                flow_value=focus,
                attributes={
                    "element-type": FlowElementType.FOCUS,
                    "data-type": FlowDataType.TEXT,
                    "previous-focus": self._current_focus,
                    **(args or {}),
                },
                focus=focus,
            )
            await self.on_flow_data(flow_data)
            self._current_focus = focus

    async def on_shell_input(self, command: str, workdir: str):
        flow_data = FlowData(
            flow_value=command,
            attributes={
                "element-type": FlowElementType.SHELL_INPUT,
                "data-type": FlowDataType.TEXT,
                "workdir": workdir,
            },
            focus=ViewType.SHELL,
        )
        await self.on_flow_data(flow_data)

    async def on_shell_output(self, chunk: str, channel: str):
        flow_data = FlowData(
            flow_value=chunk,
            attributes={
                "element-type": FlowElementType.SHELL_OUTPUT,
                "data-type": FlowDataType.TEXT,
                "channel": channel,
            },
            focus=ViewType.SHELL,
        )
        await self.on_flow_data(flow_data)

    async def on_new_sources(self, sources: list[str]):
        for source in sources:
            flow_data = FlowData(
                flow_value=source, attributes={"element-type": FlowElementType.SOURCE, "data-type": FlowDataType.TEXT}
            )
            await self.on_flow_data(flow_data)

    async def on_trace(self, message: str, level: Literal["info", "warning", "error"] = "info"):
        """Legacy trace method - streams message only."""
        flow_data = FlowData(
            flow_value=message,
            attributes={"element-type": FlowElementType.TRACE, "data-type": FlowDataType.TEXT, "level": level},
        )
        await self.on_flow_data(flow_data)

    async def on_trace_item(self, trace: "TraceItem"):
        """Stream full trace item as structured data."""
        # Compute summary if not set
        if trace.summary is None:
            trace.summary = trace.compute_summary()

        flow_data = FlowData(
            flow_value=trace.model_dump_json(),
            attributes={
                "element-type": FlowElementType.TRACE,
                "data-type": FlowDataType.OBJECT,
                "trace-type": trace.type.value,
                "level": trace.level.value,
            },
        )
        await self.on_flow_data(flow_data)

    async def on_result(self, result: FlowData):
        await self.on_flow_data(result)

    async def on_new_chunk(self, chunk: str):
        # Legacy method - use on_chat for new code
        await self.on_chat(chunk)

    async def on_error(self, error: Exception):
        error_message = str(error)

        if not error_message:
            error_message = f"{type(error).__name__} occurred"

        # Add exceptions attribute for ExceptionGroup cases
        if hasattr(error, "exceptions"):
            error_message += f"\nExceptions: {[str(e) for e in error.exceptions]}"

        flow_data = FlowData(
            flow_value=error_message, attributes={"element-type": FlowElementType.ERROR, "data-type": FlowDataType.TEXT}
        )
        await self.on_flow_data(flow_data)

    async def on_cached_message(self, cached_message: str):
        flow_data = FlowData(
            flow_value=cached_message,
            attributes={"element-type": FlowElementType.CACHED_MESSAGE, "data-type": FlowDataType.TEXT},
        )
        await self.on_flow_data(flow_data)

    async def on_state(self, key: str, data: dict):
        """Send flow state data."""
        flow_data = FlowData(
            flow_value=data,
            attributes={"element-type": FlowElementType.STATE, "data-type": FlowDataType.OBJECT, "key": key},
        )
        await self.on_flow_data(flow_data)

    async def on_llm_end(self):
        flow_data = FlowData(
            flow_value="LLM generation complete",
            attributes={"element-type": FlowElementType.LLM_END, "data-type": FlowDataType.TEXT},
        )
        await self.on_flow_data(flow_data)

    async def on_end(self):
        await self.on_flow_data(None)  # Signal end of stream

    async def on_reasoning(self, chunk: str):
        flow_data = FlowData(
            flow_value=chunk, attributes={"element-type": FlowElementType.REASONING, "data-type": FlowDataType.TEXT}
        )
        await self.on_flow_data(flow_data)

    async def on_chat(self, chunk: str):
        flow_data = FlowData(
            flow_value=chunk, attributes={"element-type": FlowElementType.CHAT, "data-type": FlowDataType.TEXT}
        )
        await self.on_flow_data(flow_data)

    def is_same_flow_data_streaming(self, flow_data: FlowData | None) -> bool:
        """Check if new flow data can continue streaming to current element.

        Uses FlowElementType.streamable_types() to determine which element types
        support streaming consolidation (accumulating content without reopening tags).

        Special handling: FlowData with "final"="true" attribute always starts a new element,
        even if element type is streamable, to ensure final results are properly tagged.

        Returns:
            True if flow_data can append to current stream without new tags
        """
        if flow_data is None or self.current_streaming_flow_data is None:
            return False

        # Check if this is marked as final - if so, force new element
        if flow_data.final:
            return False
        if flow_data.element_type == self.current_streaming_flow_data.element_type:
            # Check if this element type supports streaming consolidation
            if flow_data.element_type in FlowElementType.streamable_types():
                if flow_data.group_id:
                    if flow_data.channel:
                        if (
                            flow_data.group_id == self.current_streaming_flow_data.group_id
                            and flow_data.channel == self.current_streaming_flow_data.channel
                        ):
                            return True
                        else:
                            return False
                else:
                    if flow_data.channel:
                        if flow_data.channel == self.current_streaming_flow_data.channel:
                            return True
                        else:
                            return False
                return True
        return False

    async def close_current_flow_data_streaming(self):
        if self.current_streaming_flow_data is not None:
            end_xml = self.current_streaming_flow_data.end_tag_xml
            self.current_streaming_flow_data = None
            return end_xml
        return None

    async def _handle_stream_end(self) -> str:
        """Handle the end of stream (None case) - close any open XML and mark as done."""
        xml_to_add = ""
        if self.current_streaming_flow_data is not None:
            xml_to_add = await self.close_current_flow_data_streaming() or ""
        self._done = True
        return xml_to_add

    async def _handle_channel_switch(self, new_data: FlowData) -> str:
        """Handle switching from one virtual channel to another - close previous and open new."""
        xml_to_add = ""

        # Close the current channel if it exists and is different
        if self.current_streaming_flow_data is not None:
            same_stream = self.is_same_flow_data_streaming(new_data)
            if not same_stream:
                closing_xml = await self.close_current_flow_data_streaming() or ""
                xml_to_add = closing_xml

        # Open new channel if not continuing same stream
        if not self.is_same_flow_data_streaming(new_data):
            self.current_streaming_flow_data = new_data
            opening_xml = new_data.start_tag_xml
            content = new_data.content or ""
            xml_to_add += opening_xml + content
        else:
            # Continue streaming to same channel - just add content
            content = new_data.content or ""
            xml_to_add += content

        return xml_to_add

    async def _convert_flow_data_to_xml(self, data: FlowData | None) -> str:
        """Convert FlowData to XML string, handling virtual channels and stream end."""
        if data is None:
            # Case 2: Handle None to end the stream
            return await self._handle_stream_end()
        else:
            # Cases 1 & 3: Convert FlowData to XML, handling virtual channels
            return await self._handle_channel_switch(data)

    async def _broadcast(self, data: FlowData | None) -> None:
        """Send chunk to all active consumer queues and update history.

        This function:
        1. Converts FlowData objects into XML strings to be emitted and added to history
        2. Handles the None case to end the stream (and close XML of last element if needed)
        3. Manages virtual channels that open XML tags and accumulate content until switched
        """
        async with self._lock:
            # Convert FlowData to XML string
            xml_to_add = await self._convert_flow_data_to_xml(data)

            # Update history
            self._history += xml_to_add

            # Create chunk for distribution
            chunk = QueueChunk(data=xml_to_add) if xml_to_add else None

            # Broadcast to all queues
            if chunk:
                await asyncio.gather(*(queue.put(chunk) for queue in self._queues), return_exceptions=True)
            if data is None:
                # Send None to signal end of stream
                await asyncio.gather(*(queue.put(None) for queue in self._queues), return_exceptions=True)
                self._done = True

    async def __aiter__(self) -> AsyncGenerator[str | Exception, None]:
        # Capture history and done state while holding lock, but don't yield inside lock
        async with self._lock:
            history = self._history if self._history else None
            done = self._done
            # Create a new queue for this iterator only if not done
            if not done:
                queue = asyncio.Queue[QueueChunk]()
                self._queues.append(queue)
            else:
                queue = None

        # Yield history outside the lock to avoid holding lock during iteration
        if history:
            yield history
        if done:
            return

        try:
            while True:
                next_item = await queue.get()
                if next_item is None:
                    break
                yield next_item.data
        finally:
            # Remove this queue when iterator is done
            async with self._lock:
                if queue and queue in self._queues:
                    self._queues.remove(queue)

    async def _get_next_chunk(
        self, consumer_queue: asyncio.Queue[QueueChunk], timeout: float | None = None
    ) -> QueueChunk:
        """Get the next chunk, prioritizing UX queue over consumer queue."""
        chunk = await get_from_queues(self._ux_queue, consumer_queue, timeout=timeout)
        return chunk

    def get_history(self) -> str:
        return self._history
