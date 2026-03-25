import logging
import traceback

from pydantic_graph import Graph

from flow_sdk.builtin.process import CompletionRequest
from flow_sdk.core.flow.models.process_deps import ComputeSession
from flow_sdk.core.flow.models.state.flow_state import FlowState
from flow_sdk.core.flow.nodes.route_human_input import RouteHumanInput
from flow_sdk.core.flow.nodes.simple_response import SimpleResponse
from flow_sdk.core.flow.nodes.use_tool import UseTool
from flow_sdk.core.flow.nodes.wait_for_human_input import WaitForHumanInput

# --- Graph Definition ---
process_graph = Graph[FlowState, ComputeSession](
    nodes=[
        RouteHumanInput,
        SimpleResponse,
        WaitForHumanInput,
        UseTool,
    ],
)


# logging.info(f"Graph mermaid diagram:\n{process_graph.mermaid_code(start_node=RouteHumanInput)}")


def sync_chat_options_from_request(state: FlowState, completion_request: CompletionRequest) -> None:
    """
    Sync chat options from completion request to flow state.
    Updates the user's value while preserving model_choice from previous runs.
    """
    # Update user's value from request, preserve model_choice
    state.chat_options.mode.value = completion_request.flow_mode
    state.chat_options.search = completion_request.enable_search


# --- Main Execution ---
async def execute_process(user_prompt: str, process_session: ComputeSession):
    if process_session.completion_request:
        if process_session.completion_request.message != user_prompt:
            raise ValueError("User prompt does not match completion request message")
    else:
        process_session.completion_request = CompletionRequest(message=user_prompt)
    persistence = process_session.flow.state_persistence
    # Start the graph execution
    logging.info("Starting process graph execution...")
    try:
        await process_session.callback_handler.on_user_message(user_prompt)
        async with process_session.initialize():
            async with process_graph.iter_from_persistence(
                persistence,
                deps=process_session,
            ) as run:
                # Sync chat options from completion request to state
                # This updates user's values while preserving model_choice from previous runs
                if process_session.completion_request:
                    current_state = persistence.history[-1].state if persistence.history else FlowState()
                    sync_chat_options_from_request(current_state, process_session.completion_request)

                assert isinstance(run.next_node, RouteHumanInput), f"Expected RouteHumanInput, got {run.next_node}"
                run.next_node.user_prompt = user_prompt
                while True:
                    node = await run.next()
                    if isinstance(node, WaitForHumanInput):
                        await run.next()
                        break
            # After graph execution completes, restore artifacts that were added during execution
            # The graph execution overwrites our changes, so we need to re-add them
            if persistence.history and hasattr(process_session, "_execution_artifacts"):
                post_graph_state = persistence.history[-1].state
                for artifact_dict in process_session._execution_artifacts:
                    post_graph_state.artifacts.append(artifact_dict)
    except Exception as e:
        traceback.print_exc()
        await process_session.callback_handler.on_error(e)
        raise
    finally:
        process_session.flow.state_persistence = persistence
        # Save the flow to persist the updated state
        await process_session.flow.save()
        await process_session.callback_handler.on_end()
        logging.info("--- Graph Execution Finished ---")
