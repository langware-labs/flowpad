from __future__ import annotations

import asyncio
import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime
from typing import Any, AsyncIterator, Awaitable, Callable, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field
from pydantic_ai.usage import RunUsage, UsageLimits
from pydantic_graph import GraphRunContext

from flow_sdk.flowpad_types.enums import WorkerCapability, WorkerTaskStatus, WorkerType
from flow_sdk.core.flow.models.process_deps import ComputeSession
from flow_sdk.core.flow.models.state.flow_state import FlowModelMessage, FlowState
from flow_sdk.core.flow.tools import FlowStreamEvent


class WorkerRequest(BaseModel):
    """Request sent to a worker."""

    task_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    prompt: str | List[str]
    ctx: GraphRunContext[FlowState, ComputeSession]
    instructions_method: Callable[[], Awaitable[str]]
    timeout_seconds: Optional[int] = None
    usage_limits: UsageLimits | None = None
    capabilities: List[WorkerCapability] = Field(default_factory=list)


class WorkerResponse(BaseModel):
    """Response from a worker."""

    new_messages: List[FlowModelMessage]
    run_usage: RunUsage
    status: WorkerTaskStatus
    execution_time_seconds: Optional[float] = None
    timestamp: datetime = Field(default_factory=datetime.now)
    stop_reason: Optional[str] = None  # Reason if flow was stopped early (e.g., stop_on_skill)


WorkerStreamEvent = FlowStreamEvent | WorkerResponse


class WorkerEnvironment(BaseModel):
    """Environment configuration for worker execution."""

    workdir: Optional[str] = None
    env_vars: Dict[str, str] = Field(default_factory=dict)
    mcp_servers_enabled: bool = True
    compute_node_config: Optional[Dict[str, Any]] = None


class WorkerConfig(BaseModel):
    """Configuration for a worker instance."""

    model_config = ConfigDict(protected_namespaces=())

    worker_type: WorkerType
    capabilities: List[WorkerCapability] = Field(default_factory=list)
    model_name: Optional[str] = None
    max_concurrent_tasks: Optional[int] = None
    default_timeout_seconds: Optional[int] = None
    environment: WorkerEnvironment = Field(default_factory=WorkerEnvironment)
    custom_settings: Dict[str, Any] = Field(default_factory=dict)


class WorkerHealth(BaseModel):
    """Health status of a worker."""

    is_healthy: bool
    active_tasks: int
    total_tasks_completed: int
    last_error: Optional[str] = None
    uptime_seconds: float
    memory_usage_mb: Optional[float] = None


@dataclass
class WorkerInterface(ABC):
    """Abstract base class defining the worker interface."""

    @property
    @abstractmethod
    def config(self) -> WorkerConfig:
        """Get worker configuration."""
        pass

    @abstractmethod
    async def health_check(self) -> WorkerHealth:
        """Check worker health status."""
        pass

    @abstractmethod
    def execute_task(self, request: WorkerRequest) -> AsyncIterator[WorkerStreamEvent]:
        """Execute a task and stream results."""
        ...

    @abstractmethod
    async def get_task_result(self, task_id: str) -> Optional[WorkerResponse]:
        """Get final result of a completed task."""
        pass

    @abstractmethod
    async def cancel_task(self, task_id: str) -> bool:
        """Cancel a running task."""
        pass

    @abstractmethod
    async def cleanup(self) -> None:
        """Cleanup worker resources."""
        pass


class BaseWorker(WorkerInterface):
    """Base class for all workers."""

    def __init__(self, config: WorkerConfig):
        self._config = config
        self.recorded_parts: list = []
        self.recorded_text: str = ""

    @property
    def config(self) -> WorkerConfig:
        """Get worker configuration."""
        return self._config

    async def health_check(self) -> WorkerHealth:
        """Check worker health status."""
        return WorkerHealth(
            is_healthy=True,
            active_tasks=0,
            total_tasks_completed=0,
            last_error=None,
            uptime_seconds=0,
            memory_usage_mb=None,
        )

    async def get_task_result(self, task_id: str) -> Optional[WorkerResponse]:
        """Get final result of a completed task."""
        return None

    async def cancel_task(self, task_id: str) -> bool:
        """Cancel a running task."""
        return False

    async def cleanup(self) -> None:
        """Cleanup worker resources."""
        pass


class WorkerRegistry(BaseModel):
    """Registry for managing multiple worker instances."""

    workers: Dict[WorkerType, WorkerInterface] = Field(default_factory=dict)

    def register_worker(self, worker_type: WorkerType, worker: WorkerInterface) -> None:
        """Register a new worker."""
        self.workers[worker_type] = worker

    def get_worker(self, worker_type: WorkerType, config: WorkerConfig | None = None) -> WorkerInterface:
        """Get a worker by ID."""
        if worker_type == WorkerType.AUTO:
            worker_type = WorkerType.CLAUDE_CODE_CLI
        worker = self.workers.get(worker_type)
        if worker is None:
            config = config or WorkerConfig(worker_type=worker_type)
            if worker_type == WorkerType.PYDANTIC_AI:
                from .pydantic_ai_worker import PydanticAIWorker

                worker = PydanticAIWorker(config=config)
            elif worker_type == WorkerType.CLAUDE_CODE:
                from .claude_code_worker import ClaudeCodeWorker

                worker = ClaudeCodeWorker(config=config)
            elif worker_type == WorkerType.CLAUDE_CODE_CLI:
                from .claude_code_cli_worker import ClaudeCodeCLIWorker

                worker = ClaudeCodeCLIWorker(config=config)
            elif worker_type == WorkerType.UNSECURED_CLAUDE:
                from .unsecured_claude_worker import UnsecuredClaudeCodeWorker

                worker = UnsecuredClaudeCodeWorker(config=config)
            elif worker_type == WorkerType.MOCK:
                from .mock_worker import MockWorker

                worker = MockWorker(config=config)
            # elif worker_type == WorkerType.SIMPLE:
            #     from .simple_worker import SimpleWorker

            #     worker = SimpleWorker(config=config)
            else:
                raise ValueError(f"Worker type {worker_type} not currently supported")
            # Register the newly created worker for reuse
            self.workers[worker_type] = worker
        return worker

    async def shutdown_all(self) -> None:
        """Shutdown all registered workers."""
        cleanup_tasks = [worker.cleanup() for worker in self.workers.values()]
        await asyncio.gather(*cleanup_tasks, return_exceptions=True)
        self.workers.clear()
