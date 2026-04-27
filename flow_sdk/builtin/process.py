import json
import logging
import os
import tempfile
import textwrap
from datetime import datetime
from flow_sdk._compat import StrEnum
from pathlib import Path
from typing import ClassVar, Literal, Optional, TypeGuard, TypeVar
from xml.etree import ElementTree as ET

from fastapi import BackgroundTasks, HTTPException
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, ConfigDict, Field, field_serializer
from pydantic.alias_generators import to_camel
from pydantic_ai.messages import TextPart, UserPromptPart

from flow_sdk.config import StorageProvider, default_service_config
from flow_sdk.api.api_types.api_field import APIField, EntityField
from flow_sdk.api.type_id import TypeId
from flow_sdk.builtin.faas.compute_node import ComputeNode
from flow_sdk.builtin.task import Task
from flow_sdk.builtin.workspace import Workspace
from flow_sdk.core import Entity, action
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter
from flow_sdk.core.flow.mcp_server import MCPConnector
from flow_sdk.core.flow.models.state.flow_state import (
    FlowMode,
    FlowModelRequest,
    FlowModelResponse,
    FlowState,
    FlowStatePersistence,
)
from flow_sdk.core.flow.tools import ToolCallInvocationPart, get_tool_box
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.core.responses import ApiFailResponse, ApiResponse, ApiResponseStatus, ApiSuccessResponse
from flow_sdk.external_apis.llm import LLMMessage
from flow_sdk.external_apis.llm.llm_connector import send_request_to_llm
from flow_sdk.external_apis.llm.llm_drivers.definitions import LLMProvider, LLMResponse
from flow_sdk.external_apis.llm.llm_drivers.flow_data import UserMessageType
from flow_sdk.core.flow.streaming.response_handler import StreamingResponseHandler
from flow_sdk.external_apis.llm.utils.utils import clean_json_completion, typed_messages
from flow_sdk.external_apis.llm.utils.xml_chunk_parser import process_xml
from flow_sdk.flowpad_types.machine_status import MachineStatus
from flow_sdk.flowpad_types.runtime_environment import ExecutionEnvironmentStatus
from flow_sdk.core.resource_management.scan.system_profile.types import SystemProfile

EMPTY_FLOW_TITLE = "Empty Flow"


class FlowUserInputField(BaseModel):
    name: str
    description: str
    type: Literal["string"] = "string"


class FlowExecutionFlags(BaseModel):
    """
    Flags controlling flow execution behavior.

    These flags allow fine-grained control over how the agent flow executes,
    including early stopping conditions and classification modes.
    """

    model_config = ConfigDict(alias_generator=to_camel, validate_by_name=True)

    classify_only: bool = Field(
        default=False,
        description="Stop after classification without executing the full flow",
    )
    classify_planner_supported: bool = Field(
        default=False,
        description="Enable planner classification support (experimental)",
    )
    stop_on_skill: bool = Field(
        default=False,
        description="Stop flow execution immediately after a skill tool is invoked",
    )


class CompletionRequest(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, validate_by_name=True)

    message: str
    flow_mode: FlowMode = Field(default=FlowMode.AGENT)
    enable_search: bool = Field(default=False)
    uploaded_file_paths: list[str] = Field(default_factory=list)
    execution_flags: FlowExecutionFlags = Field(default_factory=FlowExecutionFlags)
    labels: list[str] = Field(default_factory=list)
    user_message_type: UserMessageType = Field(default=UserMessageType.TEXT)

    # Backwards compatibility properties
    @property
    def classify_only(self) -> bool:
        return self.execution_flags.classify_only

    @property
    def classify_planner_supported(self) -> bool:
        return self.execution_flags.classify_planner_supported

    @property
    def stop_on_skill(self) -> bool:
        return self.execution_flags.stop_on_skill


class FeedbackSentiment(StrEnum):
    POSITIVE = "positive"
    NEUTRAL = "neutral"
    NEGATIVE = "negative"


class ChatMessageFeedback(BaseModel):
    thread_index: int
    message_index: int
    sentiment: FeedbackSentiment
    feedback: str


class ExpertResponse(BaseModel):
    status: ApiResponseStatus
    data: str


T = TypeVar("T")


def is_empty_list(lst: list[T] | None) -> TypeGuard[None | list[None]]:
    return lst is None or len(lst) == 0


def is_not_empty_list(lst: list[T] | None) -> TypeGuard[list[T]]:
    return lst is not None and len(lst) > 0


class FlowMessageBase(BaseModel):
    """Base class for flow messages with common fields and XML parsing capabilities."""

    content: str
    timestamp: datetime

    @field_serializer("timestamp", when_used="json")
    def serialize_timestamp(self, dt: datetime) -> str:
        """
        Custom serializer to ensure timestamps always include microseconds in JSON.
        This prevents duplicate React keys caused by precision loss when microseconds are zero.
        """
        # Always include microseconds (6 decimal places) even if they're zero
        iso_str = dt.isoformat(timespec="microseconds")
        # Replace +00:00 with Z for consistency
        if iso_str.endswith("+00:00"):
            iso_str = iso_str[:-6] + "Z"
        return iso_str

    @property
    def xmlTree(self) -> ET.Element | None:
        """
        Parse the content as XML and return the tree structure.
        Wraps content in a flow-root element for consistent parsing.
        Returns None if content cannot be parsed as XML.
        """
        try:
            # Wrap content with flow-root to handle trailing text
            wrapped_content = f"<flow-root>{self.content}</flow-root>"
            return ET.fromstring(wrapped_content)
        except (ET.ParseError, Exception):
            # If parsing fails, return None
            return None

    @property
    def chat_content(self) -> str:
        """
        Extract the clean content after flow-reasoning tag.
        Returns the tail content after flow-reasoning, or the full content if no flow-reasoning exists.
        """
        tree = self.xmlTree
        chat_element = tree.find("flow-chat")
        if chat_element is not None:
            return chat_element.text
        return ""


class FlowUserMessage(FlowMessageBase):
    role: Literal["user"]
    mode: FlowMode | None = None


class FlowAssistantMessage(FlowMessageBase):
    role: Literal["assistant"]


FlowMessage = FlowUserMessage | FlowAssistantMessage


class Flow(Entity):
    type: str = APIField(default=BuiltinEntityType.FLOW.value)
    title: str | None = APIField(default=None)
    workspace_id: str | None = APIField(default=None)
    agent_id: str | None = APIField(default=None)
    raw_state_persistence: str | None = EntityField(default=None, blob=True)
    _state_persistence: FlowStatePersistence | None = None
    # TODO shall we take it out to a separate entity to avoid contamination?
    slack_thread_ts: Optional[str] = APIField(default=None)
    fs_storage_provider: StorageProvider | None = StorageProvider.SANDBOX
    project_id: str | None = APIField(default=None)
    asset_ref: str | None = APIField(default=None)
    current_compute_node_id: str | None = APIField(default=None)
    current_terminal_id: str | None = APIField(default=None)
    worker_session_id: str | None = APIField(default=None)
    created_by_flowpad: bool = APIField(default=True)
    _api_visible: ClassVar[bool] = True

    @property
    def state_persistence(self):
        if self._state_persistence is not None:
            return self._state_persistence
        if self.exist_in_db and not self.is_expanded_blobs():
            raise ValueError("raw_state_persistence blob is not fetched")
        if self._state_persistence is None:
            # Dynamically import the process graph to avoid circular imports
            from flow_sdk.core.flow.process_execution import process_graph

            self._state_persistence = FlowStatePersistence()
            self._state_persistence.set_graph_types(process_graph)
            if self.raw_state_persistence:
                try:
                    self._state_persistence.load_json(self.raw_state_persistence)
                except Exception as e:
                    # Log the error and reset state if it's corrupted
                    import logging

                    logging.warning(f"Failed to load flow state persistence for flow {self.id}: {e}")
                    logging.info("Resetting flow state to empty")
                    # Keep the persistence object empty, which will start fresh
                    self._state_persistence = FlowStatePersistence()
                    self._state_persistence.set_graph_types(process_graph)
                    # Clear the corrupted state from storage
                    self.raw_state_persistence = None
        return self._state_persistence

    @state_persistence.setter
    def state_persistence(self, state_persistence: FlowStatePersistence):
        self._state_persistence = state_persistence
        self.raw_state_persistence = state_persistence.dump_json().decode("utf-8")

    @property
    def state(self) -> FlowState | None:
        return self.state_persistence.history[-1].state if self.state_persistence.history else None

    async def is_waiting_for_user_input(self) -> bool:
        """Check if the flow is currently waiting for user input."""
        user_input_fields = await self.get_user_input_fields()
        return bool(user_input_fields)

    async def get_user_input_fields(self) -> list[FlowUserInputField]:
        """Get the user input fields from the flow state."""
        messages = await self.messages()
        if not messages:
            return []
        last_message = messages[-1]
        if isinstance(last_message, FlowUserMessage):
            return []
        last_message_events = process_xml(last_message.content)
        user_input_fields: list[FlowUserInputField] = []
        for event in last_message_events:
            if event["event"] == "flow-env-var" and (args := event.get("args")) and (name := args.get("name")):
                user_input_fields.append(
                    FlowUserInputField(name=name, description=args.get("description", ""), type="string")
                )
        return user_input_fields

    async def get_compute_node(self) -> ComputeNode | None:
        # TODO [FLOWPAD-1363] ComputeNode.get_one(source_entity=self.typeid) doesn't support visitor scoped requests
        outgoing_relationships = await self.get_outgoing_relationships()
        related_compute_node_typeids = [
            rel.to_typeid
            for rel in outgoing_relationships
            if rel.to_typeid and rel.to_typeid.type == ComputeNode.get_type()
        ]
        if not related_compute_node_typeids:
            return None
        if len(related_compute_node_typeids) > 1:
            raise ValueError(f"Multiple compute nodes found for flow {self.typeid}")
        return await ComputeNode.get_by_typeid(related_compute_node_typeids[0])

    async def get_mcp_connector(self) -> MCPConnector | None:
        compute_node = await self.get_compute_node()
        if not compute_node:
            return None
        return MCPConnector(compute_node=compute_node)

    async def messages(self) -> list[FlowMessage]:
        if not self.state:
            return []
        messages: list[FlowMessage] = []
        current_response_timestamp = None
        callback_handler = StreamingResponseHandler()
        tool_box = get_tool_box(callback_handler)
        for message in self.state.message_history:
            if message.kind == "request":
                for part in message.parts:
                    if part.part_kind == "user-prompt":
                        # Get the user prompt
                        user_content = part.content
                        if isinstance(user_content, str):
                            user_content = [user_content]
                        for content_part in user_content:
                            if not isinstance(content_part, str):
                                raise ValueError(f"Unknown user prompt part: {content_part}")
                            if current_response_timestamp is not None:
                                # Add the last response to the processed messages
                                await callback_handler.on_end()
                                callback_items = [item async for item in callback_handler]
                                messages.append(
                                    FlowAssistantMessage(
                                        role="assistant",
                                        content="".join(callback_items),
                                        timestamp=current_response_timestamp,
                                    )
                                )
                                # Reset the current response and timestamp
                                current_response_timestamp = None
                                callback_handler = StreamingResponseHandler()
                                tool_box = get_tool_box(callback_handler)
                            # Add the user prompt to the processed messages
                            messages.append(
                                FlowUserMessage(
                                    role="user", content=content_part, timestamp=part.timestamp, mode=message.mode
                                )
                            )
                    elif part.part_kind == "tool-return":
                        await tool_box.on_tool_result(part)
            else:
                if current_response_timestamp is None:
                    # If the current response timestamp is not set, set it to the message timestamp
                    current_response_timestamp = message.timestamp
                for part in message.parts:
                    await tool_box.on_part_start(part)
                    if part.part_kind == "tool-call":
                        await tool_box.on_tool_call_invocation(ToolCallInvocationPart.from_tool_call_part(part))
        if current_response_timestamp and callback_handler:
            # Add the last response to the history
            await callback_handler.on_end()
            callback_items = [item async for item in callback_handler]
            messages.append(
                FlowAssistantMessage(
                    role="assistant", content="".join(callback_items), timestamp=current_response_timestamp
                )
            )
        return messages

    @property
    def workspace_typeid(self) -> TypeId | None:
        if not self.workspace_id:
            return None
        return TypeId(type=Workspace.get_type(), id=self.workspace_id)

    @property
    def last_mode(self) -> FlowMode | None:
        """Returns the mode of the last message, or None if no messages exist."""
        if not self.state:
            return None
        if not self.state.chat_options:
            return None
        return self.state.chat_options.mode.resolved

    @action.post(action_name="note-item-updated")
    async def note_updated_item(self, item_name: str):
        await self.expand_blobs()
        self._inject_user_message(f"I have updated {item_name}.")
        self._inject_assistant_message(f"{item_name} has been updated.")
        await self.update()
        return ApiSuccessResponse()

    def _inject_user_message(self, content: str):
        """Add a user message to the chat without triggering flow execution."""
        # Add to flow state message history (for micro app history API)
        if self.state:
            user_request = FlowModelRequest(parts=[UserPromptPart(content=content)], mode=None)
            self.state.message_history.append(user_request)
            # Properly update the state persistence without overwriting
            if self.state and self.state_persistence.history:
                # Update the current state in the last history item
                self.state_persistence.history[-1].state = self.state
                # Trigger the persistence update using the existing setter
                self.state_persistence = self.state_persistence

    def _inject_assistant_message(self, content: str):
        """Add an assistant message to the chat without triggering flow execution."""
        # Add to flow state message history (for micro app history API)
        if self.state:
            assistant_response = FlowModelResponse(parts=[TextPart(content=content)])
            self.state.message_history.append(assistant_response)
            # Properly update the state persistence without overwriting
            if self.state and self.state_persistence.history:
                # Update the current state in the last history item
                self.state_persistence.history[-1].state = self.state
                # Trigger the persistence update using the existing setter
                self.state_persistence = self.state_persistence

    async def create_title(self):
        async def _set_title(title: str):
            """Helper to set title on fresh flow instance."""
            fresh_flow = await Flow.get_by_id(self.id)
            if fresh_flow:
                fresh_flow.title = title
                await fresh_flow.update()
            else:
                self.title = title
                await self.update()

        def _generate_fallback_title(content: str | None) -> str:
            """Generate a simple title from message content."""
            if not content:
                return "New Chat"
            fallback = content[:50].strip().split("\n")[0]
            return fallback[:40] + "..." if len(fallback) > 40 else fallback

        try:
            process_messages = await self.messages()
            if not process_messages:
                raise ValueError("No messages in chat to create title from")
            first_message = process_messages[0]

            # In desktop mode, skip LLM and use simple fallback title
            if default_service_config.is_desktop:
                logging.info("Desktop mode - generating simple title from message content")
                await _set_title(_generate_fallback_title(first_message.content))
                return

            class ChatTitleOutput(BaseModel):
                reasoning: str = Field(
                    description="Reasoning of why you think the following chat title is the best fit"
                )
                chat_title: str = Field(description="Suggested concise chat title")

            messages = typed_messages(
                instruction=textwrap.dedent(
                    """
                    You are a helpful assistant that creates chat titles from chat messages.
                    Keep the chat title concise and to the point, it should be at most 3 words.
                    Try to encapsulate the main topic of the chat, but don't be too verbose.
                    """
                ),
                input_schema={
                    "type": "string",
                    "title": "chat",
                    "description": "The markdown content of the chat to create a title from",
                },
                output_schema=ChatTitleOutput.model_json_schema(),
                input_data=first_message.content,
            )
            llm_response: LLMResponse = await send_request_to_llm(messages, "gpt-5-nano", json_output=True)
            try:
                response = clean_json_completion(llm_response.completion)
            except json.JSONDecodeError:
                response = llm_response.completion

            chat_title_output = ChatTitleOutput.model_validate(response)
            await _set_title(chat_title_output.chat_title)
        except ValueError:
            logging.warning("No messages in chat to create title from")
            await _set_title(EMPTY_FLOW_TITLE)
        except Exception as e:
            # LLM call failed - use simple fallback title
            logging.warning(f"LLM title generation failed, using fallback: {e}")
            try:
                await _set_title(_generate_fallback_title(first_message.content))
            except NameError:
                await _set_title("New Chat")

    @action.all(action_name="get-host")
    async def get_host(self, port: int, redirect: bool = True):
        int_port = int(port)
        if not 1024 <= int_port <= 65535:
            return ApiFailResponse(message="Invalid port")

        compute_node = await self.get_compute_node()
        if not compute_node:
            return ApiFailResponse(message="get-host: No compute node found")
        host = compute_node.get_host(int_port)

        # If redirect=False, return the URL as JSON response (for caching/prefetch)
        if not redirect:
            return ApiResponse(data={"url": host, "port": int_port})

        return RedirectResponse(url=host)

    @action.all(action_name="get-machine-status")
    async def get_machine_status(self) -> ApiResponse:
        """Get machine status (processes, network) from the compute node using psutil.

        This is a READ-ONLY operation - it does not attempt to resume paused nodes.
        If the node is in an unrecoverable state, it returns ERROR status quickly.

        Delegates to ComputeNode.get_machine_status().
        """
        compute_node = await self.get_compute_node()
        if not compute_node:
            machine_status = MachineStatus(
                node_provider_status=ExecutionEnvironmentStatus.NOT_FOUND,
                status_msg="Compute node not yet created",
            )
        else:
            machine_status = await compute_node.get_machine_status()

        return ApiSuccessResponse(data=machine_status.model_dump())

    @action.all(action_name="get-system-profile")
    async def get_system_profile(self) -> ApiResponse:
        """Get system profile (Claude Code environment info) from the compute node.

        This is a READ-ONLY operation - it does not attempt to resume paused nodes.
        If the node is in an unrecoverable state, it returns an empty SystemProfile.

        Delegates to ComputeNode.get_system_profile().
        """
        compute_node = await self.get_compute_node()
        if not compute_node:
            system_profile = SystemProfile(
                generated="",
                machine="unknown",
            )
        else:
            system_profile = await compute_node.get_system_profile()

        return ApiSuccessResponse(data=system_profile.model_dump())

    @action.post(action_name="control-service")
    async def control_service(self, artifact_id: str, action_type: str) -> ApiResponse:
        """Control a service (start/stop/restart) on the compute node.

        Args:
            artifact_id: ID of the artifact (WEBAPP or APP_SERVICE) to control
            action_type: One of 'start', 'stop', 'restart'
        """
        compute_node = await self.get_compute_node()
        if not compute_node:
            return ApiFailResponse(message="control-service: No compute node found")

        # Get the artifact from flow state
        process_state = await self.get_state()
        artifacts = process_state.artifacts if process_state else []
        artifact = next((a for a in artifacts if a.id == artifact_id), None)

        if not artifact:
            return ApiFailResponse(message=f"Artifact {artifact_id} not found")

        port = artifact.port or (artifact.metadata or {}).get("port")
        if not port:
            return ApiFailResponse(message=f"Artifact {artifact_id} has no port defined")

        port_num = int(port)

        try:
            if action_type == "stop":
                # Find process by port and kill it
                stop_script = f"""
import psutil
import json
import signal

port = {port_num}
killed = False
error = None

for conn in psutil.net_connections(kind='inet'):
    if conn.laddr and conn.laddr.port == port and conn.status == 'LISTEN':
        if conn.pid:
            try:
                proc = psutil.Process(conn.pid)
                proc.terminate()
                proc.wait(timeout=5)
                killed = True
            except psutil.NoSuchProcess:
                killed = True
            except Exception as e:
                error = str(e)
        break

print(json.dumps({{"success": killed, "error": error, "port": port}}))
"""
                script_path = os.path.join(tempfile.gettempdir(), "_stop_service.py")
                await compute_node.write_files(script_path, stop_script)
                cmd = await compute_node.run_command(f"python3 {script_path}", background=False)
                await cmd.wait(timeout=15.0)

                result = json.loads(cmd.all_stdout) if cmd.all_stdout else {}
                if result.get("error"):
                    return ApiFailResponse(message=result["error"])
                if not result.get("success"):
                    return ApiFailResponse(message=f"No service found on port {port_num}")

                return ApiSuccessResponse(data={"action": "stop", "port": port_num})

            elif action_type == "start":
                start_cmd = artifact.start_cmd or (artifact.metadata or {}).get("start_cmd")
                if not start_cmd:
                    return ApiFailResponse(message=f"Artifact {artifact_id} has no start_cmd defined")

                # Run start command in background using nohup
                cwd = artifact.path if artifact.path else "/home/user"
                log_path = os.path.join(tempfile.gettempdir(), f"service_{port_num}.log")
                full_cmd = f"cd {cwd} && nohup {start_cmd} > {log_path} 2>&1 &"
                await compute_node.run_command(full_cmd, background=True)

                # Wait and check if service started
                import asyncio

                for _ in range(10):  # Try for 10 seconds
                    await asyncio.sleep(1)
                    check_script = f"""
import psutil
import json
for conn in psutil.net_connections(kind='inet'):
    if conn.laddr and conn.laddr.port == {port_num} and conn.status == 'LISTEN':
        print(json.dumps({{"running": True, "pid": conn.pid}}))
        exit(0)
print(json.dumps({{"running": False}}))
"""
                    script_path = os.path.join(tempfile.gettempdir(), "_check_service.py")
                    await compute_node.write_files(script_path, check_script)
                    cmd = await compute_node.run_command(f"python3 {script_path}", background=False)
                    await cmd.wait(timeout=5.0)
                    result = json.loads(cmd.all_stdout) if cmd.all_stdout else {}
                    if result.get("running"):
                        return ApiSuccessResponse(data={"action": "start", "port": port_num, "pid": result.get("pid")})

                return ApiFailResponse(message=f"Service failed to start on port {port_num} within 10 seconds")

            elif action_type == "restart":
                # Stop first (ignore if not running)
                await self.control_service(artifact_id, "stop")
                # Small delay for port release
                import asyncio

                await asyncio.sleep(0.5)
                # Then start
                return await self.control_service(artifact_id, "start")

            else:
                return ApiFailResponse(message=f"Unknown action: {action_type}. Use 'start', 'stop', or 'restart'")

        except Exception as e:
            logging.error(f"Error controlling service: {e}")
            return ApiFailResponse(message=str(e))

    @action.all(action_name="feedback")
    async def receive_feedback(self, feedback: ChatMessageFeedback, background_tasks: BackgroundTasks) -> ApiResponse:
        raise NotImplementedError("Feedback is not implemented yet")

    @action.post(action_name="open-issue")
    async def open_issue(self) -> ApiResponse:
        from flow_sdk.external_apis.llm.utils import markdown_to_lexical
        try:
            request_info = get_current_request_info()
            if not request_info:
                return ApiFailResponse(message="Open Issue error, No request info")
            expert_id = request_info.request_parameters.get("expert_id")
            await self.expand_blobs()
            messages = await self.messages()
            if not messages:
                raise ValueError("No messages in chat to create issue from")

            class ChatIssueInput(BaseModel):
                chat_messages: list[LLMMessage] = Field(description="Chat messages")

            class ChatIssueOutput(BaseModel):
                reasoning: str = Field(description="Why this summary fits the issue")
                title: str = Field(description="Short issue title", examples=["The user doesn't have an API key"])
                goal: str = Field(
                    description="User's goal", examples=["The user tries to display billing information using API"]
                )
                what_we_did_so_far: str = Field(
                    description="Chat summary of attempts and current status. What the assistant suggested, what was the feedback, and what the current status is."
                )

            chat_issue_input = ChatIssueInput(
                chat_messages=[LLMMessage(role=message.role, content=message.content) for message in messages]
            )

            messages = typed_messages(
                instruction=textwrap.dedent(
                    """
                    You are a helpful assistant that creates chat summaries from chat messages.
                    The chat describes an issue or multiple issues the user encountered that needs to be opened and escalated to an expert.
                    Focus mainly on unresolved issues. Resolved issues could be used as references.
                    
                    """
                ).strip(),
                input_schema=ChatIssueInput.model_json_schema(),
                output_schema=ChatIssueOutput.model_json_schema(),
                input_data=chat_issue_input.model_dump(),
            )

            llm_response: LLMResponse = await send_request_to_llm(messages, LLMProvider.Anthropic, json_output=True)
            try:
                response = clean_json_completion(llm_response.completion)
            except json.JSONDecodeError:
                response = llm_response.completion

            chat_issue_output = ChatIssueOutput.model_validate(response)

            # Build the full markdown description
            markdown_description = (
                textwrap.dedent("""
                    **Goal**  
                    {chat_issue_output.goal}

                    **What we did so far**  
                    {chat_issue_output.what_we_did_so_far}

                    [View Chat](/{self.typeid.type}/{self.typeid.id})
                    """)
                .strip()
                .format(chat_issue_output=chat_issue_output, self=self)
            )

            # Convert markdown to Lexical format for the task description
            lexical_description = json.dumps(markdown_to_lexical.markdown_to_lexical(markdown_description))

            task = Task(
                title=f"🚨 {chat_issue_output.title}",
                description=lexical_description,
                assignee=expert_id,
            )
            await task.save(self)

            chat_title = self.title
            self.title = f"🙋 {chat_title}"
            await self.save()

            # TODO this may be a security issue
            # await self.grant_role(
            #     to_role=AuthRole.EDITOR.value,
            #     to_e=TypeId(type=User.get_type(), id=expert_id),
            # )

            workspace = await Workspace.get_entity_with_role_on(self)
            if not workspace:
                raise HTTPException(status_code=404, detail="Workspace entity not found")
            await workspace.add_child(task)

            # Add flow-assistance message to chat history
            self._inject_user_message("Request assitance.")
            self._inject_assistant_message(f"Assitance request was sent: {chat_issue_output.title}")
            await self.update()

            logging.debug(f"Task created with title: {chat_issue_output.title}")
            logging.debug(f"Reasoning: {chat_issue_output.reasoning}")

            return ApiSuccessResponse(
                data=ExpertResponse(data=chat_issue_output.title, status=ApiResponseStatus.SUCCESS)
            )

        except ValueError:
            logging.warning("No messages in chat to create issue from")
            return ApiFailResponse(
                data=ExpertResponse(data="Open Issue: Failed to create issue from chat", status=ApiResponseStatus.FAIL)
            )

    @action.get(action_name="get-trace")
    async def get_trace(self):
        await self.expand_blobs()
        if not self.state:
            # Return empty trace items list if no state exists yet
            return ApiSuccessResponse(data=[])
        return ApiSuccessResponse(data=self.state.trace_items)

    @action.get(action_name="checkpoint-diff")
    async def get_checkpoint_diff(self, checkpoint_hash: str):
        request_info = get_current_request_info()
        if not request_info:
            raise HTTPException(status_code=401, detail="Unauthorized: visitor ID required")
        target_typeid = request_info.target_entity_typeid
        if not target_typeid:
            raise HTTPException(status_code=400, detail="target_entity_typeid parameter is required")

        mcp_connector = await self.get_mcp_connector()
        if not mcp_connector:
            return ApiFailResponse(message="checkpoint-diff: No compute node found")

        try:
            git_diff = await mcp_connector.source_control.get_git_diff(checkpoint_hash)
            return ApiSuccessResponse(message="Git diff retrieved", data=git_diff)
        except Exception as e:
            logging.error(f"Error getting git diff: {e}")
            raise HTTPException(status_code=500, detail=f"Error getting git diff: {str(e)}")

    @action.get(action_name="current-checkpoint")
    async def get_current_checkpoint(self):
        """Get the current checkpoint hash (git HEAD)."""
        mcp_connector = await self.get_mcp_connector()
        if not mcp_connector:
            return ApiFailResponse(message="current-checkpoint: No compute node found")

        try:
            # Use the existing FlowSourceControl method
            current_hash = await mcp_connector.source_control.get_current_checkpoint_hash()
            return ApiSuccessResponse(message="Current checkpoint retrieved", data={"checkpoint_hash": current_hash})
        except Exception as e:
            logging.error(f"Error getting current checkpoint: {e}")
            raise HTTPException(status_code=500, detail=f"Error getting current checkpoint: {str(e)}")

    @action.post(action_name="restore-checkpoint")
    async def restore_checkpoint(self, checkpoint_hash: str):
        """Restore a checkpoint using git reset --hard.

        Args:
            checkpoint_hash: The git commit hash to restore to
        """
        if not checkpoint_hash:
            raise HTTPException(status_code=400, detail="checkpoint_hash parameter is required")

        mcp_connector = await self.get_mcp_connector()
        if not mcp_connector:
            return ApiFailResponse(message="restore-checkpoint: No compute node found")

        try:
            # Execute git reset --hard via source control
            git_reset_cmd = await mcp_connector.source_control.revert_to_checkpoint_hash(checkpoint_hash)

            # Check if reset was successful
            if git_reset_cmd.exit_code != 0:
                error_msg = git_reset_cmd.all_stderr or "Unknown error during git reset"
                raise HTTPException(status_code=500, detail=f"Failed to restore checkpoint: {error_msg}")

            return ApiSuccessResponse(
                message="Checkpoint restored successfully", data={"checkpoint_hash": checkpoint_hash}
            )
        except HTTPException:
            raise
        except Exception as e:
            logging.error(f"Error restoring checkpoint: {e}")
            raise HTTPException(status_code=500, detail=f"Error restoring checkpoint: {str(e)}")

    @classmethod
    async def get_or_create_for_session(cls, session_id: str, owner_typeid: TypeId | None = None) -> "Flow":
        """
        Find an existing Flow by worker_session_id or create a new one.

        Args:
            session_id: The Claude session ID to search for
            owner_typeid: Optional owner TypeId for newly created flows

        Returns:
            Flow entity (existing or newly created)
        """

        # Try to find existing flow by worker_session_id
        flows = await cls.get_all(entities_filter=QueryFilter(match=ExpressionNode(worker_session_id=session_id)))
        if flows:
            return flows[0]

        # Create new flow with created_by_flowpad=False
        new_flow = cls(
            title=f"Auto-created for session {session_id[:8]}...",
            worker_session_id=session_id,
            created_by_flowpad=False,
        )
        await new_flow.save(owner_typeid)

        logging.info(f"Created new flow {new_flow.id} for session {session_id}")
        return new_flow

