"""
ClaudeCodeAgenticWorker - Lean Claude Code execution via claude_agent_sdk.

Migrated from FlowPad's Claude Code worker implementation.

Uses ClaudeSDKClient directly (no PTY complexity).
Supports streaming input mode for pause/resume/inject capabilities.
Multi-turn: keeps SDK client alive between execute() calls.

Requires ``claude_agent_sdk`` (optional dependency). If not installed,
importing this module raises ImportError at class instantiation time,
not at module level -- so the __init__.py re-export stays safe with a
try/except guard.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
import sys
import uuid
from typing import Any, AsyncIterator

from flow_sdk.builtin.agentic_workers.base.context import AgenticContext
from flow_sdk.builtin.agentic_workers.base.worker import AgenticWorker
from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowData, FlowDataType, FlowElementType

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Optional SDK import -- deferred so the module can be imported even when
# claude_agent_sdk is not installed.
# ---------------------------------------------------------------------------
_SDK_AVAILABLE = False
try:
    from claude_agent_sdk import (  # type: ignore[import-untyped]
        AssistantMessage,
        ClaudeAgentOptions,
        ClaudeSDKClient,
        ResultMessage,
        SystemMessage,
        TextBlock,
        ThinkingBlock,
        ToolResultBlock,
        ToolUseBlock,
        UserMessage,
        create_sdk_mcp_server,
        tool,
    )

    _SDK_AVAILABLE = True
except ImportError:
    pass


def _gen_instruction_id() -> str:
    """Generate an 8-char base62 random instruction ID."""
    alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
    return "".join(secrets.choice(alphabet) for _ in range(8))


# System prompt for AMD instruction handling
AMD_INSTRUCTION_PROMPT = """You are executing AMD (Agentic Markdown) instructions.

## Flow Instructions

Call `flow_instruction` tool for each flow instruction:
- `id`: Use EXACT id from id="..." attribute, or "" if none
- `type`: set | get | exception
- `attrs`: JSON with attributes (name, value, error, etc.)

## Exceptions

CRITICAL: When asked to "confirm", "verify", "check", or "assert" values, you MUST:
1. Retrieve current values using flow_instruction(type="get")
2. Compare them to the expected values stated in the instruction
3. If ANY value does NOT match the expected value, you MUST call:
   flow_instruction(type="exception", attrs='{"error": "description of mismatch"}')

Do NOT just report the correct values. If expected values don't match actual values, RAISE AN EXCEPTION.
"""


class ClaudeCodeAgenticWorker(AgenticWorker):
    """Worker that executes prompts via Claude Code SDK.

    Lean implementation:
    - Uses ClaudeSDKClient directly (no PTY complexity)
    - All config from AgenticContext
    - Streams FlowData directly

    Streaming Input Mode:
    - Supports pause/resume/inject for interactive sessions
    - Uses asyncio.Queue for message injection
    - Uses asyncio.Event for pause/resume control

    Multi-turn Support:
    - Keeps SDK client alive between execute() calls
    - Same session maintains conversation context
    - Call close_session() to terminate
    """

    def __init__(self) -> None:
        if not _SDK_AVAILABLE:
            raise ImportError(
                "claude_agent_sdk is required for ClaudeCodeAgenticWorker. "
                "Install it with: pip install claude-agent-sdk"
            )
        self._client: Any = None  # ClaudeSDKClient
        self._input_queue: asyncio.Queue[str | None] | None = None
        self._paused: asyncio.Event | None = None
        self._session_active: bool = False
        # History tracking
        self._session_id: str | None = None
        self._history: list[FlowData] = []
        # Group-id tracking for streaming consolidation
        self._block_group_ids: dict[int, str] = {}
        # Context cache for multi-turn
        self._context_cache: AgenticContext | None = None
        # Pending outputs from tool calls
        self._pending_outputs: list[FlowData] = []

    @staticmethod
    def _create_data_server(stack_frame: dict, pending_outputs: list):
        """Create MCP server with flow instruction tool."""

        @tool(
            "flow_instruction",
            "Execute a flow instruction (set, get, etc.)",
            {"id": str, "type": str, "attrs": str},
        )
        async def flow_instruction(args: dict) -> dict:
            instr_id = args.get("id", "")
            instr_type = args.get("type", "")
            attrs_json = args.get("attrs", "{}")

            if not instr_id:
                instr_id = _gen_instruction_id()

            try:
                attrs = json.loads(attrs_json) if isinstance(attrs_json, str) else attrs_json
            except json.JSONDecodeError:
                attrs = {}

            result: dict[str, Any] = {"id": instr_id, "type": instr_type}

            if instr_type == "set":
                name = attrs.get("name", "")
                value = attrs.get("value", "")
                stack_frame[name] = value
                result["name"] = name
                result["value"] = value
                output_text = f"Set {name} = {value}"

            elif instr_type == "get":
                name = attrs.get("name", "")
                value = stack_frame.get(name)
                result["name"] = name
                result["value"] = value
                output_text = str(value) if value is not None else ""

            elif instr_type == "exception":
                error_msg = attrs.get("error", "Unknown error")
                instruction = attrs.get("instruction", "")
                result["error"] = error_msg
                result["instruction"] = instruction
                output_text = f"Exception: {error_msg}"

            else:
                result["error"] = f"Unknown instruction type: {instr_type}"
                output_text = result["error"]

            element_type = FlowElementType.ERROR if instr_type == "exception" else FlowElementType.DATA
            pending_outputs.append(
                FlowData(
                    flow_value=result,
                    attributes={
                        "element-type": element_type,
                        "data-type": FlowDataType.OBJECT,
                    },
                )
            )

            return {
                "content": [{"type": "text", "text": output_text}],
                "is_error": "error" in result,
            }

        return create_sdk_mcp_server(
            name="flow",
            version="1.0.0",
            tools=[flow_instruction],
        )

    async def execute(
        self,
        prompt: str,
        context: AgenticContext,
    ) -> AsyncIterator[FlowData]:
        """Execute prompt via Claude Code SDK.

        Supports multi-turn conversation by keeping SDK client alive between calls.
        The client is only closed when close_session() is called or on error.
        """
        # Set environment variables from context
        for key, value in context.env_vars.items():
            os.environ[key] = value

        self._context_cache = context

        # Create data tools if AMD support is enabled and stack_frame available
        mcp_servers: dict[str, Any] = {}
        system_append = context.instructions or ""
        if context.amd_support and context.stack_frame is not None:
            mcp_servers["data"] = self._create_data_server(context.stack_frame, self._pending_outputs)
            system_append = f"{AMD_INSTRUCTION_PROMPT}\n\n{system_append}".strip()

        # Initialize streaming input mode support
        if self._input_queue is None:
            self._input_queue = asyncio.Queue()
        if self._paused is None:
            self._paused = asyncio.Event()
            self._paused.set()  # Start in resumed state
        self._session_active = True

        # Initialize client if not already active (multi-turn support)
        if self._client is None:
            options_dict: dict[str, Any] = {
                "cwd": context.workdir,
                "setting_sources": ["user", "project"],
                "system_prompt": {
                    "type": "preset",
                    "preset": "claude_code",
                    "append": system_append,
                },
                "permission_mode": context.permission_mode,
                "max_thinking_tokens": context.max_thinking_tokens,
                "include_partial_messages": True,
                "mcp_servers": mcp_servers,
            }

            if context.model:
                options_dict["model"] = context.model

            # Session resume / fork
            if context.resume_session_id:
                options_dict["resume"] = context.resume_session_id
                self.load_history_from_session(context.resume_session_id)
                if context.fork_session:
                    options_dict["fork_session"] = True
                    logger.info(f"ClaudeCodeAgenticWorker: Forking session {context.resume_session_id}")
                else:
                    logger.info(f"ClaudeCodeAgenticWorker: Resuming session {context.resume_session_id}")

            options = ClaudeAgentOptions(**options_dict)
            self._client = ClaudeSDKClient(options=options)
            await self._client.__aenter__()
            logger.info("ClaudeCodeAgenticWorker: Created new SDK client session")
        else:
            logger.info("ClaudeCodeAgenticWorker: Reusing existing SDK client session (multi-turn)")

        # Execute with SDK
        try:
            await self._client.query(prompt)

            async for message in self._client.receive_messages():
                if self._paused is not None:
                    await self._paused.wait()

                # Yield any pending data tool outputs
                while self._pending_outputs:
                    flow_data = self._pending_outputs.pop(0)
                    if self._should_save_to_history(flow_data):
                        self._history.append(flow_data)
                    yield flow_data

                async for flow_data in self._process_message(message):
                    if self._should_save_to_history(flow_data):
                        self._history.append(flow_data)
                    yield flow_data

                if isinstance(message, ResultMessage):
                    break

            # Yield remaining pending outputs
            while self._pending_outputs:
                flow_data = self._pending_outputs.pop(0)
                if self._should_save_to_history(flow_data):
                    self._history.append(flow_data)
                yield flow_data

            # Keep client alive for multi-turn
            self._session_active = False

        except Exception as e:
            # Windows STATUS_CONTROL_C_EXIT
            if sys.platform == "win32" and "3221225786" in str(e):
                logger.info(f"Claude Code subprocess terminated (Windows CTRL_C_EXIT): {e}")
            else:
                logger.error(f"SDK execution error: {e}", exc_info=True)
                yield FlowData(
                    flow_value=f"Error: {e}",
                    attributes={
                        "element-type": FlowElementType.ERROR,
                        "data-type": FlowDataType.TEXT,
                    },
                )
            await self._close_client()

    async def _process_message(self, message: Any) -> AsyncIterator[FlowData]:
        """Process SDK message and yield FlowData elements."""
        # Handle SystemMessage (session init)
        if isinstance(message, SystemMessage):
            subtype = getattr(message, "subtype", None)
            if subtype == "init":
                session_id = getattr(message, "session_id", None)
                if session_id:
                    self._session_id = session_id
                    logger.info(f"ClaudeCodeAgenticWorker: Captured session_id={session_id}")

                model = getattr(message, "model", None)
                tools_count = len(getattr(message, "tools", []))
                yield FlowData(
                    flow_value=f"Session initialized: model={model}, tools={tools_count}",
                    attributes={
                        "element-type": FlowElementType.STATUS,
                        "data-type": FlowDataType.TEXT,
                    },
                )
            return

        # Handle StreamEvent for real-time streaming
        if type(message).__name__ == "StreamEvent":
            event = getattr(message, "event", None)
            if event and isinstance(event, dict):
                event_type = event.get("type", "")

                if event_type == "content_block_start":
                    index = event.get("index", 0)
                    group_id = f"g-{uuid.uuid4().hex[:12]}"
                    self._block_group_ids[index] = group_id
                    return

                if event_type == "content_block_stop":
                    return

                if event_type == "content_block_delta":
                    index = event.get("index", 0)
                    delta = event.get("delta", {})
                    delta_type = delta.get("type", "")

                    group_id = self._block_group_ids.get(index)
                    if not group_id:
                        group_id = f"g-{uuid.uuid4().hex[:12]}"
                        self._block_group_ids[index] = group_id

                    if delta_type == "text_delta":
                        text = delta.get("text", "")
                        if text:
                            yield FlowData(
                                flow_value=text,
                                attributes={
                                    "element-type": FlowElementType.CHAT,
                                    "data-type": FlowDataType.TEXT,
                                    "group-id": group_id,
                                },
                            )

                    elif delta_type == "thinking_delta":
                        thinking = delta.get("thinking", "")
                        if thinking:
                            yield FlowData(
                                flow_value=thinking,
                                attributes={
                                    "element-type": FlowElementType.REASONING,
                                    "data-type": FlowDataType.TEXT,
                                    "group-id": group_id,
                                },
                            )
            return

        # Handle AssistantMessage (complete blocks)
        if isinstance(message, AssistantMessage):
            for idx, block in enumerate(message.content):
                group_id = self._block_group_ids.get(idx)
                if not group_id:
                    group_id = f"g-{uuid.uuid4().hex[:12]}"

                if isinstance(block, TextBlock):
                    if block.text:
                        yield FlowData(
                            flow_value=block.text,
                            attributes={
                                "element-type": FlowElementType.CHAT,
                                "data-type": FlowDataType.TEXT,
                                "complete": "true",
                                "group-id": group_id,
                            },
                        )

                elif isinstance(block, ThinkingBlock):
                    if block.thinking:
                        yield FlowData(
                            flow_value=block.thinking,
                            attributes={
                                "element-type": FlowElementType.REASONING,
                                "data-type": FlowDataType.TEXT,
                                "complete": "true",
                                "group-id": group_id,
                            },
                        )

                elif isinstance(block, ToolUseBlock):
                    tool_data = {
                        "tool_name": block.name,
                        "tool_call_id": block.id,
                        "args": block.input,
                    }
                    yield FlowData(
                        flow_value=tool_data,
                        attributes={
                            "element-type": FlowElementType.TOOL_CALL,
                            "data-type": FlowDataType.OBJECT,
                            "tool-name": block.name,
                            "tool-id": block.id,
                        },
                    )

            self._block_group_ids.clear()
            return

        # Handle UserMessage (tool results)
        if isinstance(message, UserMessage):
            for block in message.content:
                if isinstance(block, ToolResultBlock):
                    content = block.content
                    if isinstance(content, str):
                        try:
                            content = json.loads(content)
                        except json.JSONDecodeError:
                            pass

                    result_data = {
                        "tool_call_id": block.tool_use_id,
                        "content": content,
                        "is_error": getattr(block, "is_error", False),
                    }
                    yield FlowData(
                        flow_value=result_data,
                        attributes={
                            "element-type": FlowElementType.TOOL_RESULT,
                            "data-type": FlowDataType.OBJECT,
                            "tool-id": block.tool_use_id,
                        },
                    )
            return

        # Handle ResultMessage - emit usage data
        if isinstance(message, ResultMessage):
            usage_data: dict[str, Any] = {}
            if hasattr(message, "usage") and message.usage:
                usage_data["usage"] = message.usage
            if hasattr(message, "total_cost_usd") and message.total_cost_usd is not None:
                usage_data["total_cost_usd"] = message.total_cost_usd
            if hasattr(message, "duration_ms"):
                usage_data["duration_ms"] = message.duration_ms
            if hasattr(message, "num_turns"):
                usage_data["num_turns"] = message.num_turns
            if usage_data:
                yield FlowData(
                    flow_value=usage_data,
                    attributes={
                        "element-type": FlowElementType.STATUS,
                        "data-type": FlowDataType.OBJECT,
                    },
                )
            return

        logger.debug(f"Unhandled message type: {type(message).__name__}")

    # ============ Streaming Input Mode Methods ============

    def pause(self) -> None:
        """Pause message processing."""
        if self._paused is not None:
            logger.info("ClaudeCodeAgenticWorker: Pausing message processing")
            self._paused.clear()

    def resume(self) -> None:
        """Resume message processing after pause."""
        if self._paused is not None:
            logger.info("ClaudeCodeAgenticWorker: Resuming message processing")
            self._paused.set()

    async def inject(self, message: str) -> None:
        """Inject a new message into the worker's input queue."""
        if self._input_queue is not None:
            logger.info(f"ClaudeCodeAgenticWorker: Injecting message: {message[:80]}...")
            await self._input_queue.put(message)

    async def _close_client(self) -> None:
        """Internal helper to close the SDK client."""
        if self._client is not None:
            try:
                await self._client.__aexit__(None, None, None)
            except Exception as e:
                logger.warning(f"Error closing SDK client: {e}")
            self._client = None

    async def close_session(self) -> None:
        """Close the worker's active session and clean up resources."""
        logger.info("ClaudeCodeAgenticWorker: Closing session")
        self._session_active = False

        if self._input_queue is not None:
            await self._input_queue.put(None)

        await self._close_client()

        self._input_queue = None
        self._paused = None
        self._context_cache = None

    # ============ History Interface Methods ============

    def get_session_id(self) -> str | None:
        return self._session_id

    def get_history(self) -> list[FlowData] | None:
        return self._history

    def set_history(self, history: list[FlowData]) -> None:
        self._history = history

    def manages_history(self) -> bool:
        return True

    def has_active_session(self) -> bool:
        """Check if the worker has an active SDK client session."""
        return self._client is not None

    def load_history_from_session(self, session_id: str) -> None:
        """Load history from session JSONL file."""
        from flow_sdk.builtin.agentic_workers.claude_worker.session_history import load_session_history

        self._history = load_session_history(session_id)
        logger.info(f"ClaudeCodeAgenticWorker: Loaded {len(self._history)} history items from session {session_id}")

    def _should_save_to_history(self, flow_data: FlowData) -> bool:
        """Determine if a FlowData item should be saved to history.

        Only saves complete blocks and non-streamable types.
        Excludes streaming deltas (chat/reasoning without complete='true').
        """
        attrs = flow_data.attributes or {}

        if attrs.get("complete") == "true":
            return True

        element_type = attrs.get("element-type", "")
        streamable_types = {
            FlowElementType.CHAT,
            FlowElementType.REASONING,
            "chat",
            "reasoning",
        }

        if element_type in streamable_types:
            return False

        return True
