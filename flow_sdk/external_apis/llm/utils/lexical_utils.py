import json
from typing import Any, Literal, Sequence

from flow_sdk.external_apis.llm.utils import markdown_to_lexical
from flow_sdk.external_apis.llm.utils.lexical_types import (
    LexicalCodeNode,
    LexicalCollapsableNode,
    LexicalFenceNode,
    LexicalHeadingNode,
    LexicalLinebreakNode,
    LexicalMentionNode,
    LexicalNode,
    LexicalOptionNode,
    LexicalParagraphNode,
    LexicalRoot,
    LexicalTextNode,
)


def merge_lexicals(first: LexicalRoot, second: LexicalRoot) -> LexicalRoot:
    if first.get("root", {}).get("children", None) is None or second.get("root", {}).get("children", None) is None:
        raise ValueError("Both lexicals must have a root node with children")
    first_copy = first.copy()
    first_copy["root"]["children"].extend(second["root"]["children"])
    return first_copy


def json_to_lexical(json_content: Any) -> LexicalRoot:
    return markdown_to_lexical(json_to_markdown(json_content))


def json_to_markdown(json_content: Any) -> str:
    if json_content is None:
        return ""
    elif isinstance(json_content, str):
        return json_content
    elif isinstance(json_content, dict):
        # if the json keys are strings, treat them as h3 headers
        if all(isinstance(key, str) for key in json_content.keys()):
            json_markdown = "\n".join(
                [
                    f"### {key}\n{value if isinstance(value, str) else json_to_markdown(value)}"
                    for key, value in json_content.items()
                ]
            )
        else:
            json_markdown = json.dumps(json_content)
        return json_markdown
    elif isinstance(json_content, list):
        return "\n".join(["- " + json_to_markdown(item) for item in json_content])
    else:
        return json.dumps(json_content)


def single_func_lexical(func_title: str, func_content: Any) -> LexicalRoot:
    return markdown_to_lexical(f"```{func_title}\n{json.dumps(func_content) if func_content else ''}\n```")


def add_func_to_lexical(lexical: LexicalRoot, func_title: str, func_content: Any) -> LexicalRoot:
    func_lexical = single_func_lexical(func_title, func_content)
    return merge_lexicals(lexical, func_lexical)


def create_root(children: list[LexicalNode] = []) -> LexicalRoot:
    """Add a root to a Lexical-like format."""
    return {"root": {"type": "root", "children": children, "version": 1}}


def create_text_node(text: str) -> LexicalTextNode:
    """Add a text to a Lexical-like format."""
    return {"type": "text", "text": text, "version": 1}


def create_heading_node(tag: str, children: list[LexicalNode] = []) -> LexicalHeadingNode:
    """Add a heading to a Lexical-like format."""
    return {"type": "heading", "tag": tag, "children": children, "version": 1}


def create_linebreak_node() -> LexicalLinebreakNode:
    """Add a text to a Lexical-like format."""
    return {"type": "linebreak", "version": 1}


def create_paragraph_node(children: list[LexicalNode] = []) -> LexicalParagraphNode:
    """Add a paragraph to a Lexical-like format."""
    return {"type": "paragraph", "children": children, "version": 1}


def create_mention_node(trigger: Literal["@"], value: str, data: dict = {}) -> LexicalMentionNode:
    """Add a mention to a Lexical-like format."""
    return {"type": "custom-beautifulMention", "trigger": trigger, "value": value, "data": data, "version": 1}


def create_option_node(value: str, children: list[LexicalNode] = []) -> LexicalOptionNode:
    """Add an option to a Lexical-like format."""
    return {"type": "option", "value": value, "children": children, "version": 1}


def create_collapsible_node(
    summary_children: list[LexicalNode] = [], content_children: list[LexicalNode] = [], open: bool | None = None
) -> LexicalCollapsableNode:
    collapsible_node: LexicalCollapsableNode = {
        "type": "collapsible-container",
        "children": [
            {
                "type": "collapsible-title",
                "children": summary_children,
                "version": 1,
            },
            {
                "type": "collapsible-content",
                "children": content_children,
                "version": 1,
            },
        ],
        "version": 1,
    }
    if open is not None:
        collapsible_node["open"] = open
    return collapsible_node


def create_code_node(language: str | None, children: list[LexicalNode] = []) -> LexicalCodeNode:
    """Add a code node to a Lexical-like format."""
    return {"type": "code", "language": language, "children": children, "version": 1}


def get_fence_nodes(lexical: LexicalRoot) -> list[LexicalFenceNode]:
    """Get all fence nodes recuresivly from a Lexical-like format."""

    def get_inner_fence_nodes(nodes: Sequence[LexicalNode]) -> list[LexicalFenceNode]:
        fences = []
        for node in nodes:
            if node["type"] == "fence":
                fences.append(node)
            elif "children" in node:
                fences.extend(get_inner_fence_nodes(node["children"]))
        return fences

    return get_inner_fence_nodes(lexical["root"]["children"])
