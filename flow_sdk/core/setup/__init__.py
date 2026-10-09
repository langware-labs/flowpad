"""The setup tree: an asset comes up after the assets it needs, the project last.

``tree.SetupNode`` is a node as the walk sees it; ``walk.setup_tree`` walks one (prepare ↓, children,
run ↑); ``execute.execute_setup`` is the slot + record every real caller goes through.
"""

from flow_sdk.core.setup.execute import SETUP_RUN, execute_setup, read_setup, setup_activity_path
from flow_sdk.core.setup.tree import NodeResolver, SetupNode
from flow_sdk.core.setup.walk import MAX_SETUP_DEPTH, setup_tree

__all__ = [
    "MAX_SETUP_DEPTH",
    "NodeResolver",
    "SETUP_RUN",
    "SetupNode",
    "execute_setup",
    "read_setup",
    "setup_activity_path",
    "setup_tree",
]
