from flow_sdk.builtin.agent_config import CheckpointMode
from flow_sdk.core.flow.models.process_deps import ComputeSession
from flow_sdk.core.flow.models.state.flow_state import FlowState
from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowCheckpointData


async def checkpoint_callback(deps: ComputeSession, state: FlowState, message: str):
    if deps.agent.agent_config and deps.agent.agent_config.checkpoint_mode != CheckpointMode.AUTO:
        return

    checkpoint_hash = await deps.mcp_connector.source_control.create_checkpoint(message)
    if not checkpoint_hash:
        return

    # Create FlowCheckpointData with proper attributes
    checkpoint_data = FlowCheckpointData.create(checkpoint_hash)

    # Stream the checkpoint data (includes timestamp and index automatically)
    await deps.callback_handler.on_flow_data(checkpoint_data)

    # Store FlowCheckpointData for history persistence (serializes automatically)
    state.checkpoint_items.append(checkpoint_data)
