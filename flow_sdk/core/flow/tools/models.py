"""Data models for flow tools."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import TYPE_CHECKING, Literal

from pydantic import BaseModel, Field
from pydantic_ai.messages import (
    BaseToolCallPart,
    ModelResponsePart,
    ModelResponsePartDelta,
    ToolCallPart,
    ToolReturnPart,
)

from flow_sdk.external_apis.search.web_search import (
    DEFAULT_SEARCH_AND_FETCH_RESULTS_MAX_OUTPUT_TOKENS,
    DEFAULT_SEARCH_NUM_RESULTS,
)

if TYPE_CHECKING:
    pass


@dataclass(repr=False)
class ToolCallInvocationPart(BaseToolCallPart):
    """A tool call invocation part."""

    part_kind: Literal["tool-call-invocation"] = "tool-call-invocation"
    """Part type identifier, this is available on all parts as a discriminator."""

    @classmethod
    def from_tool_call_part(cls, tool_call_part: ToolCallPart) -> ToolCallInvocationPart:
        return ToolCallInvocationPart(
            tool_name=tool_call_part.tool_name,
            args=tool_call_part.args,
            tool_call_id=tool_call_part.tool_call_id,
        )

    def to_tool_call_part(self) -> ToolCallPart:
        return ToolCallPart(
            tool_name=self.tool_name,
            args=self.args,
            tool_call_id=self.tool_call_id,
        )


FlowStreamEvent = ModelResponsePart | ModelResponsePartDelta | ToolReturnPart | ToolCallInvocationPart


class SearchMode(str, Enum):
    FAST = "fast"
    DEEP = "deep"


class SearchConfig(BaseModel):
    search_mode: SearchMode = Field(default=SearchMode.FAST)
    num_results: int = Field(default=DEFAULT_SEARCH_NUM_RESULTS)
    max_output_tokens: int = Field(default=DEFAULT_SEARCH_AND_FETCH_RESULTS_MAX_OUTPUT_TOKENS)


class FlowToolDescription(BaseModel):
    tag: str
    description: str
    args: dict[str, str]
    examples: list[str]

    @property
    def markdown_content(self):
        tool_str = f"### `{self.tag}`\n"
        tool_str += f"{self.description}\n\n"

        if self.args:
            tool_str += "**Arguments:**\n"
            for arg_name, arg_desc in self.args.items():
                tool_str += f"- `{arg_name}`: {arg_desc}\n"
            tool_str += "\n"

        if self.examples:
            tool_str += "**Examples:**\n"
            for example in self.examples:
                tool_str += f"- {example}\n"
            tool_str += "\n"

        return tool_str
