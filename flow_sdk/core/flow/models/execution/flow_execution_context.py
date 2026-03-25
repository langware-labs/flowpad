"""Flow execution context model for planning and execution operations."""

from typing import Any, Dict, Optional

from pydantic import BaseModel, ConfigDict, Field

from flow_sdk.builtin.knowledge_base.knowledge_data import KnowledgeData
from flow_sdk.core.flow.streaming.response_handler import CallbackHandler


class FlowExecutionContext(BaseModel):
    """
    Context for flow execution and planning operations.

    This model contains runtime-only context information that the planner
    and execution engine need to make decisions about plan updates and execution.
    Persistent data like root_todo, user_prompt_analysis, and history should be in FlowState.
    """

    flow_stream_handler: CallbackHandler = CallbackHandler()  # empty handler by default

    # Knowledge data containing ontology and entries
    knowledge_data: Optional[KnowledgeData] = Field(
        default=None, description="Knowledge data with ontology and entries"
    )

    # Additional execution metadata (runtime only)
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Additional execution metadata")

    model_config = ConfigDict(arbitrary_types_allowed=True)
