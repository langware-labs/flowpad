"""
LexicalDoc - A unified package for handling Lexical document format.

This module provides the LexicalDoc class and related utilities for working with
Lexical editor JSON format, including conversions to/from Markdown.
"""

import json
from typing import Any, Dict, List, Optional, Union

from pydantic import BaseModel, ConfigDict, Field

from .markdown_converter import lexical_to_markdown, markdown_to_lexical
from .types import (
    LexicalFenceNode,
    LexicalNode,
    LexicalRoot,
    empty_lexical_root,
)
from .utils import (
    create_code_node,
    create_collapsible_node,
    create_heading_node,
    create_linebreak_node,
    create_mention_node,
    create_paragraph_node,
    create_text_node,
    get_fence_nodes,
    json_to_lexical,
    merge_lexicals,
    single_func_lexical,
)


class LexicalDoc(BaseModel):
    """
    A class representing a Lexical document with conversion and manipulation capabilities.
    """

    root: LexicalRoot = Field(default_factory=lambda: empty_lexical_root.copy())

    def __init__(self, content: Optional[Union[str, Dict, LexicalRoot]] = None, **data):
        """
        Initialize a LexicalDoc instance.

        Args:
            content: Initial content, can be:
                - None: Creates an empty document
                - str: Interpreted as Markdown and converted to Lexical
                - Dict: Interpreted as a LexicalRoot structure
                - LexicalRoot: Used directly
        """
        if content is None:
            root = empty_lexical_root.copy()
        elif isinstance(content, str):
            root = markdown_to_lexical(content)
        elif isinstance(content, dict):
            # Validate it's a proper LexicalRoot structure
            if "root" in content and isinstance(content["root"], dict):
                root = content
            else:
                # Assume it's JSON content to convert
                root = json_to_lexical(content)
        else:
            raise TypeError(f"Unsupported content type: {type(content)}")

        data["root"] = root
        super().__init__(**data)

    model_config = ConfigDict(arbitrary_types_allowed=True)

    @classmethod
    def from_markdown(cls, markdown: str) -> "LexicalDoc":
        """Create a LexicalDoc from Markdown content."""
        return cls(markdown)

    @classmethod
    def from_json(cls, json_content: Any) -> "LexicalDoc":
        """Create a LexicalDoc from JSON content."""
        root = json_to_lexical(json_content)
        return cls(root=root)

    @classmethod
    def from_lexical_root(cls, lexical_root: LexicalRoot) -> "LexicalDoc":
        """Create a LexicalDoc from a LexicalRoot structure."""
        return cls(root=lexical_root)

    @property
    def children(self) -> List[LexicalNode]:
        """Get the root node's children."""
        return self.root["root"]["children"]

    def to_markdown(self) -> str:
        """Convert the document to Markdown format."""
        return lexical_to_markdown(self.root)

    def to_json(self) -> str:
        """Convert the document to JSON string."""
        return json.dumps(self.root)

    def to_dict(self) -> LexicalRoot:
        """Get the document as a dictionary (LexicalRoot)."""
        return self.root.copy()

    def merge(self, other: Union["LexicalDoc", LexicalRoot]) -> "LexicalDoc":
        """
        Merge another LexicalDoc or LexicalRoot into this document.

        Args:
            other: Another LexicalDoc instance or LexicalRoot dict

        Returns:
            A new LexicalDoc with merged content
        """
        if isinstance(other, LexicalDoc):
            other_root = other.root
        else:
            other_root = other

        merged_root = merge_lexicals(self.root, other_root)
        return LexicalDoc.from_lexical_root(merged_root)

    def add_paragraph(self, text: str) -> "LexicalDoc":
        """Add a paragraph with text to the document."""
        paragraph = create_paragraph_node([create_text_node(text)])
        self.root["root"]["children"].append(paragraph)
        return self

    def add_heading(self, text: str, level: int = 1) -> "LexicalDoc":
        """Add a heading to the document."""
        heading = create_heading_node(f"h{level}", [create_text_node(text)])
        self.root["root"]["children"].append(heading)
        return self

    def add_code_block(self, code: str, language: Optional[str] = None, title: Optional[str] = None) -> "LexicalDoc":
        """Add a code block to the document."""
        if title:
            func_lexical = single_func_lexical(title, code)
            self.root = merge_lexicals(self.root, func_lexical)
        else:
            code_node = create_code_node(language, [create_text_node(code)])
            paragraph = create_paragraph_node([code_node])
            self.root["root"]["children"].append(paragraph)
        return self

    def add_collapsible(self, title: str, content: Union[str, List[LexicalNode]], open: bool = False) -> "LexicalDoc":
        """Add a collapsible section to the document."""
        if isinstance(content, str):
            content_nodes = [create_paragraph_node([create_text_node(content)])]
        else:
            content_nodes = content

        title_nodes = [create_text_node(title)]
        collapsible = create_collapsible_node(title_nodes, content_nodes, open)
        self.root["root"]["children"].append(collapsible)
        return self

    def get_fence_nodes(self) -> List[LexicalFenceNode]:
        """Get all fence nodes from the document."""
        return get_fence_nodes(self.root)

    def add_linebreak(self) -> "LexicalDoc":
        """Add a line break to the document."""
        self.root["root"]["children"].append(create_linebreak_node())
        return self

    def add_mention(self, value: str, data: Optional[Dict] = None) -> "LexicalDoc":
        """Add a mention (@) to the document."""
        mention = create_mention_node("@", value, data or {})
        # Mentions typically go inside paragraphs
        paragraph = create_paragraph_node([mention])
        self.root["root"]["children"].append(paragraph)
        return self

    def clear(self) -> "LexicalDoc":
        """Clear all content from the document."""
        self.root = empty_lexical_root.copy()
        return self

    def is_empty(self) -> bool:
        """Check if the document is empty."""
        return len(self.root["root"]["children"]) == 0

    def __str__(self) -> str:
        """String representation (converts to Markdown)."""
        return self.to_markdown()

    def __repr__(self) -> str:
        """Developer-friendly representation."""
        num_children = len(self.children)
        return f"LexicalDoc(children={num_children})"

    def __eq__(self, other: Any) -> bool:
        """Check equality with another LexicalDoc."""
        if not isinstance(other, LexicalDoc):
            return False
        return self.root == other.root

    def __len__(self) -> int:
        """Get the number of top-level nodes in the document."""
        return len(self.children)
