import json
import logging

from bs4 import BeautifulSoup, Tag
from markdown_it_pyrs import MarkdownIt, Node

from flow_sdk.external_apis.llm.utils.lexical_types import (
    LexicalCollapsableNode,
    LexicalEmojiNode,
    LexicalFenceNode,
    LexicalHashTagNode,
    LexicalHeadingNode,
    LexicalHorizontalRuleNode,
    LexicalLinebreakNode,
    LexicalLinkNode,
    LexicalListItemNode,
    LexicalListNode,
    LexicalNode,
    LexicalParagraphNode,
    LexicalQuoteNode,
    LexicalRoot,
    LexicalTableCellNode,
    LexicalTableNode,
    LexicalTableRowNode,
    LexicalTextNode,
)
from flow_sdk.utils import filter_none_from_list

md = MarkdownIt("gfm")


def process_text_node(node: Node) -> LexicalTextNode:
    return {"type": "text", "text": node.meta.get("content", ""), "version": 1}


def process_fence_node(node: Node) -> LexicalFenceNode:
    content = node.meta.get("content", "")
    try:
        content = json.loads(content)
    except json.JSONDecodeError:
        pass
    return {"type": "fence", "info": node.meta.get("info", ""), "content": content, "version": 1}


def process_strong_node(node: Node) -> LexicalTextNode | None:
    if not len(node.children) == 1:
        return None
    child: Node = node.children[0]
    child_lexical = html_to_lexical(child)
    if child_lexical is None:
        return None
    if child_lexical["type"] != "text":
        logging.warning(f"Strong node child is not text: {node}")
        return None
    child_lexical["format"] = 1  # Bold
    return child_lexical


def process_em_node(node: Node) -> LexicalTextNode | None:
    if not len(node.children) == 1:
        return None
    child: Node = node.children[0]
    child_lexical = html_to_lexical(child)
    if child_lexical is None:
        return None
    if child_lexical["type"] != "text":
        logging.warning(f"Italic node child is not text: {node}")
        return None
    child_lexical["format"] = 2  # Italic
    return child_lexical


def process_code_node(node: Node) -> LexicalTextNode | None:
    if not len(node.children) == 1:
        return None
    child: Node = node.children[0]
    child_lexical = html_to_lexical(child)
    if child_lexical is None:
        return None
    if child_lexical["type"] != "text":
        logging.warning(f"Code node child is not text: {node}")
        return None
    child_lexical["format"] = 16  # Code formatting
    return child_lexical


def process_paragraph_node(node: Node) -> LexicalParagraphNode | LexicalNode | None:
    if len(node.children) == 1:
        # If there is only one child, return it directly. This is to avoid unnecessary nesting.
        return html_to_lexical(node.children[0])
    return {
        "type": "paragraph",
        "children": filter_none_from_list(
            [html_to_lexical(child) for child in node.children],
        ),
        "version": 1,
    }


def process_linebreak_node() -> LexicalLinebreakNode:
    return {"type": "linebreak", "version": 1}


def process_list_node(node: Node) -> LexicalListNode:
    return {
        "type": "list",
        "children": [process_listitem_node(child) for child in node.children if child.name == "list_item"],
        "version": 1,
    }


def process_listitem_node(node: Node) -> LexicalListItemNode:
    return {
        "type": "listitem",
        "children": [
            {"type": "paragraph", "children": filter_none_from_list([html_to_lexical(child)]), "version": 1}
            for child in node.children
        ],
        "version": 1,
    }


def process_table_node(node: Node) -> LexicalTableNode:
    table_rows = []
    for child in node.children:
        if child.name == "thead":
            table_rows.append(html_to_lexical(child.children[0]))
        elif child.name == "tbody":
            table_rows.extend([html_to_lexical(table_row) for table_row in child.children])
    return {"type": "table", "children": filter_none_from_list(table_rows), "version": 1}


def process_table_row(node: Node) -> LexicalTableRowNode:
    return {
        "type": "tablerow",
        "children": filter_none_from_list([html_to_lexical(child) for child in node.children]),
        "version": 1,
    }


def process_table_cell(node: Node) -> LexicalTableCellNode:
    return {
        "type": "tablecell",
        "children": [
            {"type": "paragraph", "children": filter_none_from_list([html_to_lexical(child)]), "version": 1}
            for child in node.children
        ],
        "version": 1,
    }


def process_heading_node(node: Node) -> LexicalHeadingNode:
    level = node.meta.get("level", 1)
    return {
        "type": "heading",
        "tag": f"h{level}",
        "children": filter_none_from_list([html_to_lexical(child) for child in node.children]),
        "version": 1,
    }


def process_horizontalrule_node() -> LexicalHorizontalRuleNode:
    return {"type": "horizontalrule", "version": 1}


def process_quote_node(node: Node) -> LexicalQuoteNode:
    return {
        "type": "quote",
        "children": filter_none_from_list([html_to_lexical(child) for child in node.children]),
        "version": 1,
    }


def process_hashtag_node(node: Node) -> LexicalHashTagNode:
    return {"type": "hashtag", "text": node.meta.get("content", ""), "version": 1}


def process_link_node(node: Node) -> LexicalLinkNode:
    url = node.meta.get("url", "")
    return {
        "type": "link",
        "url": url,
        "children": filter_none_from_list([html_to_lexical(child) for child in node.children]),
        "version": 1,
    }


def process_emoji_node(node: Node) -> LexicalEmojiNode:
    return {"type": "emoji", "text": node.meta.get("content", ""), "version": 1}


def process_details_tag(tag: Tag) -> LexicalCollapsableNode | None:
    summary_tags = tag.find_all("summary", recursive=False)
    if len(summary_tags) != 1:
        return None
    extracted_summary_tag = summary_tags[0].extract()
    if not isinstance(extracted_summary_tag, Tag):
        return None
    summary_children = markdown_to_lexical_children(extracted_summary_tag.decode_contents())
    content_children = markdown_to_lexical_children(tag.decode_contents())

    return {
        "type": "collapsible-container",
        "children": [
            {
                "type": "collapsible-title",
                "children": filter_none_from_list(summary_children),
                "version": 1,
            },
            {
                "type": "collapsible-content",
                "children": filter_none_from_list(content_children),
                "version": 1,
            },
        ],
        "version": 1,
    }


def parse_html_tag(tag: Tag) -> LexicalCollapsableNode | None:
    if tag.name == "details":
        return process_details_tag(tag)
    else:
        return None


def process_html_block_node(node: Node) -> LexicalCollapsableNode | None:
    # This is a design decision to parse HTML blocks and allow certain HTML tags to be converted to Lexical format.
    html_content = node.meta.get("content", "")
    body = BeautifulSoup(html_content, "lxml").find("body")
    if not isinstance(body, Tag):
        return None
    all_tags = body.find_all(recursive=False)
    if len(all_tags) != 1:
        return None
    one_tag = all_tags[0]
    if not isinstance(one_tag, Tag):
        return None
    return parse_html_tag(one_tag)


def html_to_lexical(node: Node) -> LexicalNode | None:
    """Convert a MarkdownIt Node tree to a Lexical-like format recursively."""
    # TODO Parse text formatting with binary map like lexical does https://github.com/facebook/lexical/blob/main/packages/lexical/src/LexicalConstants.ts#L39
    if node.name == "text" or node.name == "text_special":
        return process_text_node(node)
    elif node.name == "fence":
        return process_fence_node(node)
    elif node.name == "strong":
        return process_strong_node(node)
    elif node.name == "em":
        return process_em_node(node)
    elif node.name == "code_inline" or node.name == "code_block":
        return process_code_node(node)
    elif node.name == "paragraph":
        return process_paragraph_node(node)
    elif node.name == "hardbreak" or node.name == "softbreak":
        return process_linebreak_node()
    elif node.name == "bullet_list" or node.name == "ordered_list":
        return process_list_node(node)
    elif node.name == "list_item":
        return process_listitem_node(node)
    elif node.name == "table":
        return process_table_node(node)
    elif node.name == "trow":
        return process_table_row(node)
    elif node.name == "tcell":
        return process_table_cell(node)
    elif node.name == "heading":
        return process_heading_node(node)
    elif node.name == "hr":
        return process_horizontalrule_node()
    elif node.name == "blockquote":
        return process_quote_node(node)
    elif node.name == "hashtag":
        return process_hashtag_node(node)
    elif node.name == "link" or node.name == "autolink":
        return process_link_node(node)
    elif node.name == "emoji":
        return process_emoji_node(node)
    elif node.name == "html_block":
        return process_html_block_node(node)
    else:
        logging.warning(f"Unknown node name: {node.name}")
        # TODO Consider returning an error node or ignoring it
        return process_text_node(node)


def markdown_to_lexical_children(markdown_text: str) -> list[LexicalNode]:
    lexical_with_root = markdown_to_lexical(markdown_text)
    return lexical_with_root["root"]["children"]


def process_root_node(node: Node) -> LexicalRoot:
    root_children: list[LexicalNode] = filter_none_from_list([html_to_lexical(child) for child in node.children])
    for child_i, child in enumerate(root_children):
        if child["type"] == "text" or child["type"] == "linebreak":
            # Wrap text child in a paragraph
            paragraph: LexicalParagraphNode = {
                "type": "paragraph",
                "children": filter_none_from_list([child]),
                "version": 1,
            }
            root_children[child_i] = paragraph
    if not root_children:
        root_children = [{"type": "paragraph", "children": [], "version": 1}]
    return {"root": {"type": "root", "children": root_children, "version": 1}}


def markdown_to_lexical(markdown_text: str) -> LexicalRoot:
    """Convert Markdown to a Lexical-like format."""
    ast_root_node = md.tree(markdown_text)
    return process_root_node(ast_root_node)
