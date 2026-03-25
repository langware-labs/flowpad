"""Backward-compat re-export: the full ComputeNode lives at flow_sdk.builtin.faas.compute_node."""

from flow_sdk.builtin.faas.compute_node import ComputeNode  # noqa: F401

__all__ = ["ComputeNode"]
