"""Pipeline data types for flow-cli.

A Pipeline is a directed graph of agentic tasks with typed inputs/outputs
on edges, supporting splits, conditions, and parallel branches.

Format inspired by n8n (nodes + edges arrays) with typed ports from CWL.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field


class PipelineNodeType(StrEnum):
    TASK = "task"
    SWITCH = "switch"
    FORK = "fork"
    INPUT = "input"
    START = "start"
    END = "end"


class PipelinePort(BaseModel):
    """A named port on a node, carrying a typed record."""

    type: str = "any"


class SwitchCase(BaseModel):
    """One branch of a switch/conditional node."""

    when: str | None = None
    default: bool = False
    then: str


class Position(BaseModel):
    x: float = 0.0
    y: float = 0.0


class PipelineNode(BaseModel):
    """A single node in the pipeline graph."""

    id: str
    type: PipelineNodeType
    label: str
    description: str | None = None
    inputs: dict[str, PipelinePort] = Field(default_factory=dict)
    outputs: dict[str, PipelinePort] = Field(default_factory=dict)
    # switch node
    cases: list[SwitchCase] | None = None
    # fork node
    branches: list[str] | None = None
    join: str | None = None  # "all" | "first"
    config: dict[str, Any] | None = None
    position: Position | None = None


class PipelineEdge(BaseModel):
    """A directed edge connecting two node ports."""

    id: str
    from_node: str
    from_port: str
    to_node: str
    to_port: str
    record_type: str | None = None
    label: str | None = None


class RecordTypeSchema(BaseModel):
    """Schema for a typed record that flows on edges."""

    fields: dict[str, str] = Field(default_factory=dict)


class Pipeline(BaseModel):
    """A directed graph of agentic tasks with typed edges."""

    id: str
    version: str = "1.0.0"
    description: str | None = None
    nodes: list[PipelineNode] = Field(default_factory=list)
    edges: list[PipelineEdge] = Field(default_factory=list)
    record_types: dict[str, RecordTypeSchema] = Field(default_factory=dict)
