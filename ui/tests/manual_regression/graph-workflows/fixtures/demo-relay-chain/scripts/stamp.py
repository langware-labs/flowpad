"""demo-relay-chain — a GraphWorkflowFunction run in its own process: stamp the payload.

Its dict return auto-emits `done`, carrying the relays' hop count onward to the echo node.
"""
import os


def on_graph_workflow_event(event_name, data, flow_ctx):
    return {**data, "stamped": True, "stamped_by": "scripts/stamp.py", "stamped_pid": os.getpid()}
