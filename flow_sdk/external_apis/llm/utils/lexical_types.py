from __future__ import annotations

from typing import Literal, NotRequired, TypeAlias, TypedDict


class LexicalTextNode(TypedDict):
    type: Literal["text"]
    version: Literal[1]
    text: str
    format: NotRequired[int]


class LexicalLinebreakNode(TypedDict):
    type: Literal["linebreak"]
    version: Literal[1]


class LexicalParagraphNode(TypedDict):
    type: Literal["paragraph"]
    version: Literal[1]
    children: list[LexicalNode]


class LexicalListItemNode(TypedDict):
    type: Literal["listitem"]
    version: Literal[1]
    children: list[LexicalNode]


class LexicalListNode(TypedDict):
    type: Literal["list"]
    version: Literal[1]
    children: list[LexicalListItemNode]


class LexicalTableRowNode(TypedDict):
    type: Literal["tablerow"]
    version: Literal[1]
    children: list[LexicalNode]


class LexicalTableCellNode(TypedDict):
    type: Literal["tablecell"]
    version: Literal[1]
    children: list[LexicalNode]


class LexicalTableNode(TypedDict):
    type: Literal["table"]
    version: Literal[1]
    children: list[LexicalTableRowNode]


class LexicalHeadingNode(TypedDict):
    type: Literal["heading"]
    version: Literal[1]
    tag: str
    children: list[LexicalNode]


class LexicalHorizontalRuleNode(TypedDict):
    type: Literal["horizontalrule"]
    version: Literal[1]


class LexicalQuoteNode(TypedDict):
    type: Literal["quote"]
    version: Literal[1]
    children: list[LexicalNode]


class LexicalHashTagNode(TypedDict):
    type: Literal["hashtag"]
    version: Literal[1]
    text: str


class LexicalLinkNode(TypedDict):
    type: Literal["link"]
    version: Literal[1]
    children: list[LexicalNode]
    url: str


class LexicalEmojiNode(TypedDict):
    type: Literal["emoji"]
    version: Literal[1]
    text: str


class LexicalCollapsableTitleNode(TypedDict):
    type: Literal["collapsible-title"]
    version: Literal[1]
    children: list[LexicalNode]


class LexicalCollapsableContentNode(TypedDict):
    type: Literal["collapsible-content"]
    version: Literal[1]
    children: list[LexicalNode]


class LexicalCollapsableNode(TypedDict):
    type: Literal["collapsible-container"]
    version: Literal[1]
    children: list[LexicalCollapsableTitleNode | LexicalCollapsableContentNode]
    open: NotRequired[bool]


class LexicalFenceNode(TypedDict):
    type: Literal["fence"]
    version: Literal[1]
    info: str
    content: str


class LexicalMentionNode(TypedDict):
    type: Literal["custom-beautifulMention"]
    version: Literal[1]
    trigger: Literal["@"]
    value: str
    data: dict


class LexicalOptionNode(TypedDict):
    type: Literal["option"]
    version: Literal[1]
    children: list[LexicalNode]
    value: str


class LexicalCodeNode(TypedDict):
    type: Literal["code"]
    version: Literal[1]
    children: list[LexicalNode]
    language: str | None


LexicalNode: TypeAlias = (
    LexicalTextNode
    | LexicalLinebreakNode
    | LexicalParagraphNode
    | LexicalListItemNode
    | LexicalListNode
    | LexicalTableRowNode
    | LexicalTableCellNode
    | LexicalTableNode
    | LexicalHeadingNode
    | LexicalHorizontalRuleNode
    | LexicalQuoteNode
    | LexicalHashTagNode
    | LexicalLinkNode
    | LexicalEmojiNode
    | LexicalCollapsableNode
    | LexicalCollapsableTitleNode
    | LexicalCollapsableContentNode
    | LexicalFenceNode
    | LexicalMentionNode
    | LexicalOptionNode
    | LexicalCodeNode
)


class LexicalRootNode(TypedDict):
    type: Literal["root"]
    version: Literal[1]
    children: list[LexicalNode]


class LexicalRoot(TypedDict):
    root: LexicalRootNode


empty_lexical_root: LexicalRoot = {"root": {"type": "root", "children": [], "version": 1}}
