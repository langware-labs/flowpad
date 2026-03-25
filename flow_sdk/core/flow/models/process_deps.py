from __future__ import annotations

import logging
import textwrap
from contextlib import asynccontextmanager
from copy import deepcopy
from datetime import datetime
from typing import TYPE_CHECKING, Any, Callable, Dict, List

try:
    import logfire
except ImportError:

    class logfire:  # type: ignore[no-redef]
        @staticmethod
        def instrument(fn_or_name=None, **kwargs):
            if callable(fn_or_name):
                return fn_or_name
            return lambda fn: fn


if TYPE_CHECKING:
    from flow_sdk.shared import TraceItem

from pydantic import BaseModel, Field
from pydantic_ai import Agent as PydanticAIAgent
from pydantic_ai.mcp import MCPServerStreamableHTTP
from pydantic_ai.messages import ModelMessage

from flow_sdk.app.actions.env_var import add_env_var_to_entity
from flow_sdk.builtin.artifact import Artifact, ArtifactReferenceType, ArtifactType
from flow_sdk.builtin.process import CompletionRequest, Flow, FlowMode
from flow_sdk.builtin.project import Project
from flow_sdk.config import default_service_config
from flow_sdk.core.entity.entity_env.env_types import EnvVar, EnvVarType
from flow_sdk.core.flow.flow_model import FlowModel
from flow_sdk.core.flow.instructions.instruction_context import InstructionContext
from flow_sdk.core.flow.instructions.prompt_generator import generate_built_in_instructions
from flow_sdk.core.flow.mcp_server import MCPConnector
from flow_sdk.core.flow.models.execution.flow_execution_context import FlowExecutionContext
from flow_sdk.core.flow.models.flow_data import FlowData, FlowDataType, FlowElementType, ViewType
from flow_sdk.core.flow.streaming.response_handler import IteratorCallbackHandler
from flow_sdk.core.flow.tools import (
    FlowToolBox,
    get_tool_box,
    get_tools,
)
from flow_sdk.external_apis.llm import CallbackHandler
from flow_sdk.external_apis.llm.utils.xml_chunk_parser import process_xml
from flow_sdk.flowpad_types.enums import EnvOpType

from .state.flow_state import FlowModelRequest, FlowModelResponse, FlowState

if TYPE_CHECKING:
    from flow_sdk.core.flow.workers.worker import WorkerRegistry


def _remove_middle_messages_from_history(messages: List[ModelMessage]):
    if len(messages) <= default_service_config.remove_middle_messages_after_count:
        return messages

    # We keep 1/4 of the messages from the start and 3/4 of the messages from the end.
    start_keep_index = default_service_config.remove_middle_messages_after_count // 4
    end_keep_index = -(3 * default_service_config.remove_middle_messages_after_count // 4)

    while (
        (start_message := messages[start_keep_index])
        and start_message.kind == "response"
        and start_message.parts[-1].part_kind != "text"
    ):
        start_keep_index -= 1

    while (
        (end_message := messages[end_keep_index])
        and end_message.kind == "response"
        and end_message.parts[-1].part_kind != "text"
    ):
        end_keep_index += 1

    return messages[:start_keep_index] + messages[end_keep_index:]


def _apply_processed_messages(messages: List[ModelMessage]):
    return [
        message.processed_message
        if isinstance(message, (FlowModelRequest, FlowModelResponse)) and message.processed_message is not None
        else message
        for message in messages
    ]


class FlowInterceptingCallback(CallbackHandler):
    """Internal callback that intercepts events and processes results before forwarding to external callback."""

    def __init__(self, external_callback: CallbackHandler, process_session: "ComputeSession"):
        self.external_callback = external_callback
        self.process_session = process_session

    async def on_result(self, result: FlowData):
        """Intercept result events, create artifacts, then forward to external callback."""

        # Ensure we have a FlowData object
        assert isinstance(result, FlowData), f"Expected FlowData on result, got {type(result)}"
        artifact = await self._create_artifact_from_dict(result.flow_value)
        try:
            await self.save_artifact(artifact)
        except Exception as e:
            logging.error(f"Error saving artifact: {e}")
            # Forward original result if saving fails
            return await self.external_callback.on_error(e)
        result.data_type = FlowDataType.ENTITY
        result.flow_value = artifact
        return await self.external_callback.on_result(result)

    async def _create_artifact_from_dict(self, args: dict) -> Artifact:
        """Create artifact from dict args and add to flow state."""

        # Extract data from args
        path = args.get("path", "")
        name = args.get("name", path.split("/")[-1] if path else "Result")
        artifact_type_str = args.get("artifact_type", ArtifactType.FILE.value)

        # Import locally to avoid circular dependency
        from flow_sdk.core.flow.process_artifact import infer_reference_type

        ref_type_str = args.get("ref_type", infer_reference_type(path, artifact_type_str))
        description = args.get("description", f"Result: {name}")
        metadata = args.get("metadata", {})
        logging.info(f"Creating artifact from dict: {args} with metadata: {metadata}")

        # Convert string type to enum
        try:
            artifact_type = ArtifactType(artifact_type_str.upper())
        except ValueError:
            artifact_type = ArtifactType.FILE

        try:
            ref_type = ArtifactReferenceType(ref_type_str.upper())
        except ValueError:
            ref_type = ArtifactReferenceType.FILE

        # Create and return artifact (without saving)
        artifact = Artifact(
            name=name,
            artifact_type=artifact_type,
            ref_type=ref_type,
            path=path,
            description=description,
            generating_flow_id=self.process_session.flow.id if self.process_session.flow else None,
            metadata=metadata,
        )

        return artifact

    async def save_artifact(self, artifact: Artifact):
        """Save artifact to database and add to flow state."""

        # Save artifact to database and attach to project if available, otherwise to flow
        await artifact.save()
        if self.process_session.project:
            await self.process_session.project.attach_child(artifact)
            logging.info(f"Attached artifact to project: {self.process_session.project.id}")
        else:
            await self.process_session.flow.attach_child(artifact)
            logging.info(f"Attached artifact to flow: {self.process_session.flow.id}")

        # Store artifact dict for later addition after graph execution
        # The graph overwrites our changes, so we'll re-add them after it completes
        artifact_dict = artifact.model_dump()

        # Store in process_session for restoration after graph execution
        if not hasattr(self.process_session, "_execution_artifacts"):
            self.process_session._execution_artifacts = []
        self.process_session._execution_artifacts.append(artifact_dict)

        # Also try to add to current state (will be overwritten but good for debugging)
        if hasattr(self.process_session.flow, "state_persistence") and self.process_session.flow.state_persistence:
            persistence = self.process_session.flow.state_persistence
            if persistence.history:
                current_state = persistence.history[-1].state
                current_state.artifacts.append(artifact_dict)
                logging.info(
                    f"Added artifact to flow state_persistence: {artifact.id} - {artifact.name}, stored for restoration"
                )
        else:
            pass

    # Forward all other methods to external callback
    async def on_new_chunk(self, chunk: str):
        await self.external_callback.on_new_chunk(chunk)

    async def on_error(self, error: Exception):
        await self.external_callback.on_error(error)

    async def on_user_message(self, message: str):
        # Create FlowData to capture its timestamp
        from flow_sdk.core.flow.models.flow_data import FlowData, FlowDataType, FlowElementType

        flow_data = FlowData(
            flow_value=message,
            attributes={"element-type": FlowElementType.PROMPT_ECHO, "data-type": FlowDataType.TEXT},
        )

        # Store timestamp in process session for use in history building
        self.process_session.last_prompt_time = datetime.fromisoformat(flow_data.created_time.replace("Z", "+00:00"))

        # Forward to external callback (which will also create FlowData and stream it)
        await self.external_callback.on_user_message(message)

    async def on_status(self, status: str):
        await self.external_callback.on_status(status)

    async def on_ux_status(self, status: str, delay_ms: float = 1000.0):
        await self.external_callback.on_ux_status(status, delay_ms)

    async def on_focus(self, focus: ViewType, args=None):
        await self.external_callback.on_focus(focus, args)

    async def on_shell_input(self, command: str, workdir: str):
        await self.external_callback.on_shell_input(command, workdir)

    async def on_shell_output(self, event, content: str):
        await self.external_callback.on_shell_output(event, content)

    async def on_new_sources(self, sources: list[str]):
        await self.external_callback.on_new_sources(sources)

    async def on_trace(self, message: str, level="info"):
        await self.external_callback.on_trace(message, level)

    async def on_trace_item(self, trace: "TraceItem"):
        await self.external_callback.on_trace_item(trace)

    async def on_cached_message(self, cached_message: str):
        await self.external_callback.on_cached_message(cached_message)

    async def on_state(self, key: str, data: dict):
        await self.external_callback.on_state(key, data)

    async def on_reasoning(self, chunk: str):
        """Called when reasoning content is received."""
        await self.external_callback.on_reasoning(chunk)

    async def on_chat(self, chunk: str):
        """Called when chat content is received."""
        await self.external_callback.on_chat(chunk)

    async def on_end(self):
        if self.process_session.tool_box.text_handler.continuation_prompt:
            continuation_prompt = self.process_session.tool_box.text_handler.continuation_prompt
            flow_data = FlowData(
                flow_value=continuation_prompt,
                attributes={
                    "element-type": FlowElementType.CONTINUE,
                    "data-type": FlowDataType.TEXT,
                },
            )
            await self.external_callback.on_flow_data(flow_data)
            self.process_session.tool_box.text_handler.continuation_prompt = None

        await self.external_callback.on_end()

    async def on_llm_end(self):
        await self.external_callback.on_llm_end()

    async def on_flow_data(self, flow_data: FlowData):
        """Forward flow_data calls to external callback if it supports it."""
        if hasattr(self.external_callback, "on_flow_data"):
            await self.external_callback.on_flow_data(flow_data)


class ComputeSession(BaseModel):
    flow: Flow
    agent: Any
    project: Project | None = None
    workdir: str | None = None
    env: list[EnvVar] = Field(default_factory=list)
    completion_request: CompletionRequest
    last_prompt_time: datetime | None = None  # Timestamp of user prompt FlowData for history preservation
    _mcp_connector: MCPConnector
    _callback_handler: CallbackHandler
    _tool_box: FlowToolBox | None = None
    _work_agent: PydanticAIAgent[ComputeSession, str] | None = None
    _simple_agent: PydanticAIAgent[ComputeSession, str] | None = None
    _worker_registry: WorkerRegistry
    _external_mcp_servers: Dict[str, MCPServerStreamableHTTP] | None = None
    _external_tools: List[Callable] | None = None
    _skills_initialized: bool = False
    # Flow stop mechanism
    _stop_requested: bool = False
    _stop_reason: str | None = None
    _stop_message: str | None = None

    def __init__(
        self,
        flow: Flow,
        agent: Any,
        mcp_connector: MCPConnector,
        completion_request: CompletionRequest,
        callback_handler: CallbackHandler | None = None,
        external_mcp_servers: Dict[str, MCPServerStreamableHTTP] | None = None,
        external_tools: List[Callable] | None = None,
        **kwargs,
    ):
        if callback_handler is None:
            callback_handler = IteratorCallbackHandler()

        super().__init__(
            flow=flow,
            agent=agent,
            completion_request=completion_request,
            **kwargs,
        )
        self._mcp_connector = mcp_connector
        # Store the external callback and create intercepting callback
        self._external_callback_handler = callback_handler
        self._callback_handler = FlowInterceptingCallback(callback_handler, self)
        self._external_mcp_servers = external_mcp_servers or {}
        self._external_tools = external_tools or []
        from flow_sdk.core.flow.workers.worker import WorkerRegistry

        self._worker_registry = WorkerRegistry()

    @property
    def callback_handler(self) -> CallbackHandler:
        if self._callback_handler is None:
            raise ValueError("CallbackHandler not initialized")
        return self._callback_handler

    @property
    def mcp_connector(self) -> MCPConnector:
        if self._mcp_connector is None:
            raise ValueError("MCPConnector not initialized")
        return self._mcp_connector

    @property
    def worker_registry(self) -> WorkerRegistry:
        return self._worker_registry

    def add_external_mcp_server(self, name: str, mcp_server: MCPServerStreamableHTTP):
        """Add an external MCP server to the flow dependencies."""
        if self._external_mcp_servers is None:
            self._external_mcp_servers = {}
        self._external_mcp_servers[name] = mcp_server

    def get_external_mcp_server(self, name: str) -> MCPServerStreamableHTTP | None:
        """Get an external MCP server by name."""
        if self._external_mcp_servers is None:
            return None
        return self._external_mcp_servers.get(name)

    @property
    def external_mcp_servers(self) -> Dict[str, MCPServerStreamableHTTP]:
        """Get all external MCP servers."""
        return self._external_mcp_servers or {}

    def add_external_tool(self, tool: Callable):
        """Add an external tool (Python function) to the flow dependencies."""
        if self._external_tools is None:
            self._external_tools = []
        self._external_tools.append(tool)

    @property
    def external_tools(self) -> List[Callable]:
        """Get all external tools."""
        return self._external_tools or []

    # Flow stop mechanism
    def request_stop(self, reason: str, message: str | None = None) -> None:
        """
        Request the flow to stop execution.

        This can be called by tools to signal that execution should stop immediately.
        The worker will check should_stop after each tool execution.

        Args:
            reason: Internal reason for stopping (for logging)
            message: Optional final message to show to the user
        """
        self._stop_requested = True
        self._stop_reason = reason
        self._stop_message = message
        logging.info(f"Flow stop requested: {reason}")

    @property
    def should_stop(self) -> bool:
        """Check if flow stop has been requested."""
        return self._stop_requested

    @property
    def stop_reason(self) -> str | None:
        """Get the reason for the stop request."""
        return self._stop_reason

    @property
    def stop_message(self) -> str | None:
        """Get the final message to show to the user on stop."""
        return self._stop_message

    def clear_stop_request(self) -> None:
        """Clear the stop request (for flow reset/reuse)."""
        self._stop_requested = False
        self._stop_reason = None
        self._stop_message = None

    @property
    def local_project_dir(self) -> str:
        """Get the local temp project directory."""
        return default_service_config.local_temp_project_dir

    @property
    def skills_folder(self) -> str:
        """Get the path to the skills folder within the project directory."""
        return default_service_config.skills_folder

    def setup_skills(self) -> None:
        """
        Initialize skills by copying them from source to the local project directory.

        This should be called before running the agent to ensure skills are available.
        Always copies production skills, clearing any stale skills from previous runs.
        """
        if self._skills_initialized:
            return

        import os
        import shutil
        from pathlib import Path

        from flow_sdk.core.flow.instructions.skill_manager import SkillManager

        # Clear any existing skills to ensure fresh production skills
        # This prevents stale skills from previous test runs from persisting
        skills_dest = Path(self.skills_folder)
        if skills_dest.exists():
            shutil.rmtree(skills_dest)
            logging.info(f"Cleared existing skills at {self.skills_folder}")

        # Ensure project directory exists
        os.makedirs(self.local_project_dir, exist_ok=True)

        # Get source skills folder and copy to destination
        source_folder = default_service_config.claude_skills_source_folder

        if Path(source_folder).exists():
            try:
                manager = SkillManager.from_folder(source_folder)
                if len(manager) > 0:
                    manager.copy_to(self.local_project_dir)
                    logging.info(f"Initialized {len(manager)} skills in {self.skills_folder}")
            except Exception as e:
                logging.warning(f"Failed to initialize skills: {e}")

        self._skills_initialized = True

    @property
    def tool_box(self) -> FlowToolBox:
        async def handle_on_write(path: str, content: str):
            async with self.mcp_connector.fs_mcp_server:
                logging.info(f"Writing to {path}")
                await self.mcp_connector.fs_mcp_server.direct_call_tool(
                    "str_replace_editor",
                    {"command": "create", "path": path, "file_text": content},
                )

        async def handle_on_env_var(name: str, var_type: str, description: str):
            """Create an env var entry when LLM generates a flow-env-var tag"""
            if not self.project:
                logging.warning(f"No project available to create env var '{name}'")
                return

            try:
                # Convert var_type string to EnvVarType enum
                try:
                    env_var_type = EnvVarType(var_type)
                except ValueError:
                    logging.warning(f"Invalid var_type '{var_type}', defaulting to API_KEY")
                    env_var_type = EnvVarType.API_KEY

                # Use the helper function to add the env var
                await add_env_var_to_entity(
                    entity=self.project,
                    name=name,
                    var_type=env_var_type,
                    description=description or f"Environment variable for {name}",
                    value=None,  # No value yet, user will provide it
                    skip_if_exists=True,  # Don't error if it already exists
                )

                logging.info(f"Created env var '{name}' of type '{var_type}' on project {self.project.typeid}")
            except Exception as e:
                logging.error(f"Failed to create env var '{name}': {e}", exc_info=True)
                raise

        if self._tool_box is None:
            self._tool_box = get_tool_box(
                self.callback_handler,
                handle_on_write if self.flow_mode == FlowMode.AGENT else None,
                handle_on_env_var,
                compute_session=self,
            )
        return self._tool_box

    def get_tool_box(self):
        """Get tool box - method version of tool_box property"""
        return self.tool_box

    def get_tool_box_for_context(self, ctx):
        """Get tool box for the execution context - alias for get_tool_box()"""
        return self.get_tool_box()

    async def notify_env_var_change(
        self,
        env_op: EnvOpType,
        name: str,
        var_type: EnvVarType,
        description: str | None = None,
        visible_value: str | None = None,
    ):
        """Emit a flow-env-var notification to sync frontend state.

        Args:
            env_op: The operation type (created, updated, deleted)
            name: The env var name
            var_type: The env var type
            description: Optional description
            visible_value: Optional visible value (masked for secrets)
        """
        flow_data = FlowData(
            flow_value=description or "",
            attributes={
                "element-type": "env-var",
                "data-type": FlowDataType.TEXT,
                "env_op": env_op.value,
                "name": name,
                "var_type": var_type.value,
                "visible_value": visible_value or "",
            },
        )
        await self.callback_handler.on_flow_data(flow_data)

    def get_tools(self, enable_skills: bool = True):
        """Get tools for the agent.

        Args:
            enable_skills: Whether to include the Skill tool. Defaults to True for PydanticAI workers.
                          Set to False for workers that have native Skill support (e.g., Claude Code).
        """
        # Ensure skills are initialized if skills are enabled
        if enable_skills:
            self.setup_skills()

        base_tools = get_tools(
            self.agent.agent_config.search,
            enable_search=self.enable_search,
            skills_folder=self.skills_folder if enable_skills else None,
            enable_skills=enable_skills,
        )

        # Add external Python tools if any
        all_tools = list(base_tools) if base_tools else []
        if self._external_tools:
            all_tools.extend(self._external_tools)

        return all_tools

    @property
    def flow_mode(self) -> FlowMode:
        return self.completion_request.flow_mode if self.completion_request else FlowMode.AGENT

    @property
    def enable_search(self) -> bool:
        return self.completion_request.enable_search if self.completion_request else False

    @property
    def flow_execution_context(self) -> FlowExecutionContext:
        """
        Get the flow execution context with the callback handler from the process session.
        This ensures the handler is properly initialized and passed through.
        Note: root_todo, user_prompt_analysis, and history are now in FlowState.
        """
        return FlowExecutionContext(
            flow_stream_handler=self.callback_handler,
            knowledge_data=self.agent.knowledge_data,
            metadata={
                "agent_id": self.agent.typeid,
                "agent_name": self.agent.name,
                "agentic_process_id": self.flow.typeid,
                "flow_id": self.flow.typeid,
            },
        )

    @asynccontextmanager
    async def initialize(self):
        async with self.agent, self.mcp_connector.initialize():
            # Don't manually manage external MCP servers - PydanticAI will handle them
            yield

    async def get_instruction_context(self, state: "FlowState | None" = None) -> InstructionContext:
        from flow_sdk.request_context.methods import get_current_request_user

        # Try to get current user from request context
        user = None
        try:
            user = get_current_request_user()
        except Exception:
            pass  # User not available in this context

        # Use state chat_options if available, otherwise fall back to completion_request
        if state is not None:
            enable_search = state.chat_options.search
        else:
            enable_search = self.enable_search

        context = InstructionContext(
            mcp_connector=self.mcp_connector,
            user_request=self.completion_request,
            agent_name=self.agent.name or "FlowpadAI",
            env_vars=self.env,
            user=user,
            project=self.project,
            user_instructions=self.agent.instructions,
            enable_search=enable_search,
            agent_config=self.agent.agent_config,
            skills_folder=self.skills_folder,
            enable_skills=True,  # Enable skills by default for instruction context
        )
        return context

    async def generate_built_in_instructions(self) -> str:
        context = await self.get_instruction_context()
        built_in_instructions = await generate_built_in_instructions(context)
        return built_in_instructions

    async def _knowledge_instructions(self, query_string: str, token_budget: int):
        if not self.agent.knowledge_base:
            return ""
        knowledge_documents = (
            await self.agent.knowledge_base.query_knowledge(query_string, token_budget=token_budget)
            if query_string
            else []
        )
        if not knowledge_documents:
            # No knowledge documents found, return empty string
            return ""

        await self.callback_handler.on_new_sources(
            [document[0].display_name or document[0].name for document in knowledge_documents]
        )
        knowledge_documents_message = "\n---\n".join(
            [
                f"### {document.name}\n"
                f"*Offset:* {document.offset} | *Size:* {document.size} | *Relevance:* {relevance_score:.2f}\n\n"
                f"{document.content}"
                for document, relevance_score in knowledge_documents
            ]
        )
        knowledge_instructions = textwrap.dedent(
            """
            ## Knowledge
            Here is some knowledge that may or may not be relevant to the user's question:
            {knowledge_documents_message}
            """
        ).format(knowledge_documents_message=knowledge_documents_message)
        return knowledge_instructions

    @asynccontextmanager
    async def simple_agent(self, query_string: str):
        if self._simple_agent:
            yield self._simple_agent
            return

        # Prepare user and knowledge instructions
        user_instructions = self.agent.instructions
        knowledge_instructions = await self._knowledge_instructions(
            query_string, token_budget=default_service_config.knowledge_default_token_budget
        )

        context = InstructionContext(
            mcp_connector=None,  # Simple agent doesn't need MCP
            user_request=self.completion_request,
            agent_name=self.agent.name or "FlowpadAI",
            user_instructions=user_instructions if user_instructions and user_instructions.strip() else None,
            knowledge_instructions_str=knowledge_instructions
            if knowledge_instructions and knowledge_instructions.strip()
            else None,
        )

        # Generate instructions using the new built-in instruction system
        simple_agent_instructions = await generate_built_in_instructions(context)

        # Initialize skills if not already done
        self.setup_skills()

        tools = get_tools(
            self.agent.agent_config.search,
            enable_search=self.enable_search,
            skills_folder=self.skills_folder,
            enable_skills=True,  # Enable skills for simple agent
        )

        # Add external Python tools to base tools
        if self._external_tools:
            tools = list(tools) if tools else []
            tools.extend(self._external_tools)

        # Add external MCP servers to the agent
        toolsets = []
        if self._external_mcp_servers:
            toolsets = list(self._external_mcp_servers.values())

        self._simple_agent = PydanticAIAgent[ComputeSession, str](
            model=FlowModel(model=self.agent.agent_config.llm.model),
            instructions=simple_agent_instructions,
            deps_type=ComputeSession,
            tools=tools,
            toolsets=toolsets,  # Add MCP servers as toolsets
        )
        yield self._simple_agent

    @property
    def _history_processors(self):
        return (
            self._redact_tool_results_from_history,
            self._compress_write_file_from_history,
            _remove_middle_messages_from_history,
            _apply_processed_messages,
        )

    @logfire.instrument
    def _redact_tool_results_from_history(self, messages: List[ModelMessage]):
        last_response = next((m for m in reversed(messages) if m.kind == "response"), None)
        if (
            not last_response
            or not last_response.usage.input_tokens
            or last_response.usage.input_tokens < default_service_config.redact_tool_results_after_tokens
        ):
            return messages

        for message in messages:
            if not isinstance(message, FlowModelRequest) or message.processed_message is not None:
                continue

            original_message = message.processed_message or message
            tool_return_message = None
            for part_i, part in enumerate(original_message.parts):
                if (
                    part.part_kind == "tool-return"
                    and len(part.model_response_str()) > default_service_config.redact_tool_results_after_result_length
                ):
                    tool_return_message = tool_return_message or deepcopy(original_message)
                    copied_part = tool_return_message.parts[part_i]
                    assert copied_part.part_kind == "tool-return"
                    copied_part.content = "... Redacted tool result ..."

            if tool_return_message is not None:
                message.processed_message = tool_return_message

        return messages

    @logfire.instrument
    def _compress_write_file_from_history(self, messages: List[ModelMessage]):
        last_response = next((m for m in reversed(messages) if m.kind == "response"), None)
        if (
            not last_response
            or not last_response.usage.total_tokens
            or last_response.usage.total_tokens < default_service_config.compress_write_file_after_tokens
        ):
            return messages

        for message in messages:
            if not isinstance(message, FlowModelResponse) or all(p.part_kind != "text" for p in message.parts):
                continue

            compressed_write_file_message = None
            for part_i, part in enumerate(message.parts):
                if part.part_kind == "text" and (xml_events := process_xml(part.content, tag_prefix="flow-write")):
                    for event in xml_events:
                        if (
                            event["event"] == "flow-write"
                            and len(event["content"]) > default_service_config.compress_write_file_after_write_length
                        ):
                            compressed_write_file_message = compressed_write_file_message or deepcopy(message)
                            copied_part = compressed_write_file_message.parts[part_i]
                            assert copied_part.part_kind == "text"
                            copied_part.content = copied_part.content.replace(
                                event["content"],
                                event["content"][: default_service_config.compress_write_file_after_write_length // 2]
                                + "\n... Read file for the rest of the content ...",
                            )

            if compressed_write_file_message is not None:
                message.processed_message = compressed_write_file_message

        return messages
