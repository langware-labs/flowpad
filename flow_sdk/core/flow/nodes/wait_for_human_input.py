from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING, Annotated

from pydantic_graph import BaseNode, Edge, GraphRunContext

from flow_sdk.core.flow.models.process_deps import ComputeSession
from flow_sdk.core.flow.models.state.flow_state import FlowState

if TYPE_CHECKING:
    from flow_sdk.core.flow.nodes.route_human_input import RouteHumanInput


@dataclass
class WaitForHumanInput(BaseNode[FlowState, ComputeSession]):
    async def run(
        self, ctx: GraphRunContext[FlowState, ComputeSession]
    ) -> Annotated[RouteHumanInput, Edge(label="Route Human Input")]:
        logging.info("--- Waiting for Human Input ---")

        requests = [r for r in ctx.state.message_history if r.kind == "request"]
        # filter requests that have any part with part_kind == 'user-prompt'
        user_requests = [
            r
            for r in requests
            if any(getattr(part, "part_kind", None) == "user-prompt" for part in getattr(r, "parts", []))
        ]
        if user_requests:
            user_requests[-1].mode = ctx.state.current_mode

        # Dynamically import RouteHumanInput to avoid circular import
        from flow_sdk.core.flow.nodes.route_human_input import RouteHumanInput

        return RouteHumanInput()
