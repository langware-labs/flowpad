"""Base classes for flow tool handlers."""

from __future__ import annotations

import logging
from typing import Awaitable, Callable

try:
    from colorama import Fore, init
except ImportError:
    # colorama is optional — used only for debug log coloring
    class _NoColor:
        def __getattr__(self, _):
            return ""
    Fore = _NoColor()
    def init(**_): pass

from pydantic import BaseModel
from pydantic_ai.messages import (
    ModelResponsePart,
    ModelResponsePartDelta,
    TextPart,
    TextPartDelta,
    ThinkingPart,
    ThinkingPartDelta,
    ToolCallPart,
    ToolCallPartDelta,
    ToolReturnPart,
)

from flow_sdk.core.flow.tools.models import FlowStreamEvent, ToolCallInvocationPart
from flow_sdk.core.flow.models.flow_data import FlowData, FlowDataType, FlowElementType, ViewType
from flow_sdk.core.flow.streaming.response_handler import CallbackHandler
from flow_sdk.external_apis.llm.utils.xml_chunk_parser import XMLChunkParser, XMLChunkParserEvent
from flow_sdk.utils import get_bool_env_var

init(autoreset=True)


llm_parts_debug_print: bool = get_bool_env_var("LLM_PARTS_DEBUG_PRINT", False)


def part_print(text: str, category: str | None = None) -> None:
    if not llm_parts_debug_print:
        return
    if category:
        logging.info(f"{Fore.YELLOW}\n*********New LLM PART : [{category}] *********")
    logging.info(f"{Fore.YELLOW}{text}")


async def no_op_on_write(path: str, content: str) -> None:
    pass


class FlowTextHandler(BaseModel):
    _callback_handler: CallbackHandler
    _on_write: Callable[[str, str], Awaitable[None]]
    _on_env_var: Callable[[str, str, str], Awaitable[None]] | None
    _xml_chunk_parser: XMLChunkParser
    _last_event: XMLChunkParserEvent | None = None
    _flow_create_content_buffer: str = ""
    _flow_env_var_content_buffer: str = ""
    continuation_prompt: str | None = None

    def __init__(
        self,
        callback_handler: CallbackHandler,
        on_write: Callable[[str, str], Awaitable[None]],
        on_env_var: Callable[[str, str, str], Awaitable[None]] | None = None,
        **kwargs,
    ):
        super().__init__(**kwargs)
        self._callback_handler = callback_handler
        self._on_write = on_write
        self._on_env_var = on_env_var
        self._xml_chunk_parser = XMLChunkParser(tag_prefix="flow-")

    async def on_text_part_start(self, part: TextPart):
        """Called when a part starts"""
        part_print(part.content, "Text output...")
        self._xml_chunk_parser.reset()
        for event in self._xml_chunk_parser.process_chunk(part.content):
            await self.handle_event(event)

    async def on_thinking_part_start(self, part: ThinkingPart):
        """Called when a part starts"""
        part_print(part.content, "Thinking...")
        await self._callback_handler.on_status("Thinking...")
        await self._callback_handler.on_reasoning(part.content)

    async def on_text_part_delta(self, delta: TextPartDelta):
        """Called when a part delta is received"""
        part_print(delta.content_delta)
        for event in self._xml_chunk_parser.process_chunk(delta.content_delta):
            await self.handle_event(event)

    async def on_thinking_part_delta(self, delta: ThinkingPartDelta):
        """Called when a part delta is received"""
        part_print(delta.content_delta)
        if delta.content_delta:
            await self._callback_handler.on_reasoning(delta.content_delta)

    async def handle_event(self, event):
        if self._last_event is None or event["event"] != self._last_event["event"]:
            await self._on_event_end(event)
            self._last_event = event

        if event["event"] == "chat":
            await self._callback_handler.on_status("Thinking...")
            await self._callback_handler.on_chat(event["content"])
        elif event["event"] == "flow-invoke-error":
            # Malformed </parameter></invoke> pattern detected
            self.continuation_prompt = "Continue"
        elif event["event"] == "flow-write":
            self._flow_create_path = event["args"].get("path", None) if event["args"] else None
            # Create FlowData with focus="editor" attribute
            flow_data = FlowData(
                flow_value=event["content"],
                attributes={
                    "element-type": FlowElementType.WRITE,
                    "data-type": FlowDataType.TEXT,
                    **(event["args"] or {}),
                },
                focus=ViewType.EDITOR,  # Set focus to editor for file write
            )
            await self._callback_handler.on_flow_data(flow_data)
            await self._callback_handler.on_status("Creating file...")
            self._flow_create_content_buffer += event["content"]
        elif event["event"] == "flow-env-var":
            # Buffer content for env-var tag, create FlowData only when complete (in _on_event_end)
            self._flow_env_var_content_buffer += event["content"]
        elif event["event"] == "flow-goal":
            # Handle goal focus event with UserPromptContext data
            if args := event["args"]:
                await self._callback_handler.on_state("goal", args)
                await self._callback_handler.on_new_chunk(event["content"])
        elif event["event"] == "flow-todo":
            # Handle todo focus event with Todo data
            if args := event["args"]:
                await self._callback_handler.on_state("todo", args)
                await self._callback_handler.on_new_chunk(event["content"])
        elif event["event"] == "flow-prompt_analysis":
            # Handle prompt analysis focus event with UserPromptAnalysis data
            if args := event["args"]:
                await self._callback_handler.on_state("prompt_analysis", args)
                await self._callback_handler.on_new_chunk(event["content"])
        elif event["event"] == "flow-result":
            # Handle result event - convert XML to on_result() call with Artifact structure
            result_data: FlowData = FlowData()
            result_data.element_type = FlowElementType.RESULT
            if args := event["args"]:
                result_data.focus = args.get("focus", None)

                # Create Artifact-compatible structure
                # Ensure 'path' is always available for the frontend ResultSection component
                artifact_data = {
                    "type": "artifact",  # Mark as artifact type
                    "path": args.get("path", ""),
                    "name": args.get("name", args.get("path", "").split("/")[-1] if args.get("path") else ""),
                    "ref_type": args.get("ref_type", ""),  # Empty string to allow inference
                    "artifact_type": args.get("type", "file"),
                    "description": args.get("description", ""),
                    "metadata": {},
                }
                # Include any additional attributes from args into metadata (excluding focus)
                for key, value in args.items():
                    if key not in artifact_data and key != "focus":  # Exclude focus from metadata
                        artifact_data["metadata"][key] = value

                result_data.data_type = FlowDataType.OBJECT
                result_data.flow_value = artifact_data
                await self._callback_handler.on_result(result_data)
            else:
                result_data.data_type = FlowDataType.TEXT
                result_data.flow_value = event["content"]
                await self._callback_handler.on_result(result_data)
        else:
            logging.warning(f"Unknown event: {event['event']}")

    async def _on_event_end(self, new_event: XMLChunkParserEvent):
        if self._last_event is None:
            return

        if (
            self._last_event["event"] == "flow-write"
            and (args := self._last_event["args"])
            and (path := args.get("path", None))
        ):
            await self._on_write(path, self._flow_create_content_buffer.lstrip())
            self._flow_create_content_buffer = ""
        elif self._last_event["event"] == "flow-env-var" and (args := self._last_event["args"]):
            # Create FlowData for complete env-var tag
            # Default env_op to "pending" if not specified (user input expected)
            env_op = args.get("env_op", "pending")
            flow_data = FlowData(
                flow_value=self._flow_env_var_content_buffer,
                attributes={
                    "element-type": "env-var",
                    "data-type": FlowDataType.TEXT,
                    "env_op": env_op,
                    **(args or {}),
                },
            )
            await self._callback_handler.on_flow_data(flow_data)

            # Create the env var entry if callback is provided
            if self._on_env_var and (name := args.get("name")):
                var_type = args.get("var_type", "api_key")
                description = self._flow_env_var_content_buffer
                try:
                    await self._on_env_var(name, var_type, description)
                except Exception as e:
                    logging.error(f"Error creating env var '{name}': {e}")

            # # Signal UI to focus on the env var
            # if name := args.get("name"):
            #     await self._callback_handler.on_focus("env-var", {"name": name})
            self._flow_env_var_content_buffer = ""
        elif new_event["event"] == "chat":
            await self._callback_handler.on_status("Thinking...")


class FlowToolHandler(BaseModel):
    async def on_tool_call_part_start(self, part: ToolCallPart):
        """Called when a part starts"""
        pass

    async def on_tool_call_part_delta(self, delta: ToolCallPartDelta):
        """Called when a part delta is received"""
        pass

    async def on_tool_call_invocation(self, part: ToolCallInvocationPart):
        """Called when a tool call is received"""
        pass

    async def on_tool_result(self, result: ToolReturnPart):
        """Called when a tool result is received"""
        pass


class GenericToolHandler(FlowToolHandler):
    """Generic tool handler that emits TOOL_CALL markers for any tool invocation."""

    _callback_handler: CallbackHandler

    def __init__(self, callback_handler: CallbackHandler, **kwargs):
        super().__init__(**kwargs)
        self._callback_handler = callback_handler

    async def on_tool_call_invocation(self, part: ToolCallInvocationPart):
        """Emit a TOOL_CALL marker when a tool is invoked."""
        args = part.args_as_dict() or {}
        flow_data = FlowData(
            flow_value={
                "tool_name": part.tool_name,
                "tool_call_id": part.tool_call_id,
                "args": args,
            },
            attributes={
                "element-type": FlowElementType.TOOL_CALL,
                "data-type": FlowDataType.OBJECT,
            },
        )
        await self._callback_handler.on_flow_data(flow_data)

    async def on_tool_result(self, result: ToolReturnPart):
        """Emit a TOOL_RESULT marker when a tool returns."""
        content = result.content
        # Truncate long results for display
        if isinstance(content, str) and len(content) > 500:
            content = content[:500] + "..."

        flow_data = FlowData(
            flow_value={
                "tool_name": result.tool_name,
                "tool_call_id": result.tool_call_id,
                "result": content,
            },
            attributes={
                "element-type": FlowElementType.TOOL_RESULT,
                "data-type": FlowDataType.OBJECT,
            },
        )
        await self._callback_handler.on_flow_data(flow_data)


class FlowToolBox:
    text_handler: FlowTextHandler
    tool_handlers: dict[str, FlowToolHandler]
    default_handler: FlowToolHandler | None
    _tool_call_id_to_tool_handler: dict[str, FlowToolHandler]

    def __init__(
        self,
        text_handler: FlowTextHandler,
        tool_handlers: dict[str, FlowToolHandler],
        default_handler: FlowToolHandler | None = None,
    ):
        self.text_handler = text_handler
        self.tool_handlers = tool_handlers
        self.default_handler = default_handler
        self._tool_call_id_to_tool_handler = {}

    async def on_stream_event(self, event: FlowStreamEvent):
        if isinstance(event, TextPart | ToolCallPart | ThinkingPart):
            await self.on_part_start(event)
        elif isinstance(event, TextPartDelta | ToolCallPartDelta | ThinkingPartDelta):
            await self.on_part_delta(event)
        elif isinstance(event, ToolCallInvocationPart):
            await self.on_tool_call_invocation(event)
        elif isinstance(event, ToolReturnPart):
            await self.on_tool_result(event)
        else:
            logging.warning(f"Unknown event: {event}")

    async def on_part_start(self, part: ModelResponsePart):
        if isinstance(part, TextPart):
            await self._on_text_part_start(part)
        elif isinstance(part, ToolCallPart):
            await self._on_tool_call_part_start(part)
        elif isinstance(part, ThinkingPart):
            await self._on_thinking_part_start(part)
        else:
            logging.warning(f"Unknown part: {part}")

    async def on_part_delta(self, delta: ModelResponsePartDelta):
        if isinstance(delta, TextPartDelta):
            await self._on_text_part_delta(delta)
        elif isinstance(delta, ToolCallPartDelta):
            await self._on_tool_call_part_delta(delta)
        else:
            await self._on_thinking_part_delta(delta)

    async def _on_text_part_start(self, part: TextPart):
        await self.text_handler.on_text_part_start(part)

    async def _on_text_part_delta(self, delta: TextPartDelta):
        await self.text_handler.on_text_part_delta(delta)

    async def _on_tool_call_part_start(self, part: ToolCallPart):
        if part.tool_name in self.tool_handlers:
            await self.tool_handlers[part.tool_name].on_tool_call_part_start(part)
            self._tool_call_id_to_tool_handler[part.tool_call_id] = self.tool_handlers[part.tool_name]

    async def _on_tool_call_part_delta(self, delta: ToolCallPartDelta):
        if delta.tool_call_id in self._tool_call_id_to_tool_handler:
            await self._tool_call_id_to_tool_handler[delta.tool_call_id].on_tool_call_part_delta(delta)

    async def _on_thinking_part_start(self, part: ThinkingPart):
        await self.text_handler.on_thinking_part_start(part)

    async def _on_thinking_part_delta(self, delta: ThinkingPartDelta):
        await self.text_handler.on_thinking_part_delta(delta)

    async def on_tool_call_invocation(self, part: ToolCallInvocationPart):
        if part.tool_name in self.tool_handlers:
            await self.tool_handlers[part.tool_name].on_tool_call_invocation(part)
        elif self.default_handler:
            await self.default_handler.on_tool_call_invocation(part)

    async def on_tool_result(self, result: ToolReturnPart):
        if result.tool_name in self.tool_handlers:
            await self.tool_handlers[result.tool_name].on_tool_result(result)
        elif self.default_handler:
            await self.default_handler.on_tool_result(result)
