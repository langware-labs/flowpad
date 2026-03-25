"""Node type definitions for flow execution."""

from enum import Enum


class NodeType(str, Enum):
    """Enumeration of available node types in the flow system."""

    WAIT_FOR_HUMAN_INPUT = "wait_for_human_input"
    ACHIEVE_GOAL = "achieve_goal"
    PLAN_GOAL = "plan_goal"
    ANALYZE_FAIL = "analyze_fail"
    ROUTE_HUMAN_INPUT = "route_human_input"
    USE_TOOL = "use_tool"
    SIMPLE_RESPONSE = "simple_response"
    EXECUTE_NEXT_TODO = "execute_next_todo"


class NodeTransition:
    """Represents a transition to another node with optional parameters."""

    def __init__(self, node_type: NodeType, **kwargs):
        self.node_type = node_type
        self.params = kwargs

    def __repr__(self):
        return f"NodeTransition({self.node_type.value}, {self.params})"


def create_node_transition(node_type: NodeType, **kwargs) -> NodeTransition:
    """Create a node transition with parameters."""
    return NodeTransition(node_type, **kwargs)
