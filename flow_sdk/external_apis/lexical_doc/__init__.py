"""
LexicalDoc - A unified package for handling Lexical document format.

This package provides utilities for working with Lexical editor JSON format,
including conversions to/from Markdown and various helper functions.
"""

# Main class
from .lexical_doc import LexicalDoc

# Conversion functions
from .markdown_converter import (
    lexical_to_markdown,
    markdown_to_lexical,
    markdown_to_lexical_children,
)

# Type definitions
from .types import (
    LexicalCodeNode,
    LexicalCollapsableContentNode,
    LexicalCollapsableNode,
    LexicalCollapsableTitleNode,
    LexicalEmojiNode,
    LexicalFenceNode,
    LexicalHashTagNode,
    LexicalHeadingNode,
    LexicalHorizontalRuleNode,
    LexicalLinebreakNode,
    LexicalLinkNode,
    LexicalListItemNode,
    LexicalListNode,
    LexicalMentionNode,
    LexicalNode,
    LexicalOptionNode,
    LexicalParagraphNode,
    LexicalQuoteNode,
    LexicalRoot,
    LexicalRootNode,
    LexicalTableCellNode,
    LexicalTableNode,
    LexicalTableRowNode,
    LexicalTextNode,
    empty_lexical_root,
)

# Utility functions
from .utils import (
    add_func_to_lexical,
    create_code_node,
    create_collapsible_node,
    create_heading_node,
    create_linebreak_node,
    create_mention_node,
    create_option_node,
    create_paragraph_node,
    create_root,
    create_text_node,
    get_fence_nodes,
    json_to_lexical,
    json_to_markdown,
    merge_lexicals,
    single_func_lexical,
)

__all__ = [
    # Main class
    "LexicalDoc",
    # Core types
    "LexicalNode",
    "LexicalRoot",
    "LexicalRootNode",
    "empty_lexical_root",
    # Node types
    "LexicalTextNode",
    "LexicalLinebreakNode",
    "LexicalParagraphNode",
    "LexicalListItemNode",
    "LexicalListNode",
    "LexicalTableRowNode",
    "LexicalTableCellNode",
    "LexicalTableNode",
    "LexicalHeadingNode",
    "LexicalHorizontalRuleNode",
    "LexicalQuoteNode",
    "LexicalHashTagNode",
    "LexicalLinkNode",
    "LexicalEmojiNode",
    "LexicalCollapsableNode",
    "LexicalCollapsableTitleNode",
    "LexicalCollapsableContentNode",
    "LexicalFenceNode",
    "LexicalMentionNode",
    "LexicalOptionNode",
    "LexicalCodeNode",
    # Conversion functions
    "markdown_to_lexical",
    "lexical_to_markdown",
    "markdown_to_lexical_children",
    # Utility functions
    "merge_lexicals",
    "json_to_lexical",
    "json_to_markdown",
    "single_func_lexical",
    "add_func_to_lexical",
    "create_root",
    "create_text_node",
    "create_heading_node",
    "create_linebreak_node",
    "create_paragraph_node",
    "create_mention_node",
    "create_option_node",
    "create_collapsible_node",
    "create_code_node",
    "get_fence_nodes",
]
