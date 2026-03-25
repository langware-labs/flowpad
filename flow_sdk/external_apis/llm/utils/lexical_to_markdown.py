import json
import logging
from enum import Enum


class TextLexicalFormat(Enum):
    BOLD = 1
    ITALIC = 2
    UNDERLINE = 8
    CODE = 16


def process_text_node(node: dict) -> str:
    text = node.get("text", "")
    format_code = node.get("format", 0)

    # Apply markdown based on format codes
    if format_code == TextLexicalFormat.BOLD.value:
        return f"**{text}** "
    elif format_code == TextLexicalFormat.ITALIC.value:
        return f"*{text}* "
    elif format_code == TextLexicalFormat.UNDERLINE.value:
        return f"__{text}__ "
    elif format_code == TextLexicalFormat.CODE.value:
        return f"`{text}` "
    # Add more format codes here as needed
    else:
        return text


def process_paragraph_node(paragraph: dict) -> str:
    paragraph_text = "".join([process_child(child) for child in paragraph.get("children", [])])

    # Handle alignment formatting
    # TODO handle rtl languages
    if paragraph.get("format") == "center":
        return f"<div align='center'>{paragraph_text}</div>"
    elif paragraph.get("format") == "right":
        return f"<div align='right'>{paragraph_text}</div>"

    return paragraph_text


def process_fence_node(fence: dict) -> str:
    fence_info = fence.get("info", "")
    fence_content = json.dumps(fence["content"]) if "content" in fence else ""
    return f"```{fence_info}\n{fence_content}\n```"


def process_listitem_node(list_item: dict) -> str:
    # Process each child within the list item
    item_text = "".join([process_child(child) for child in list_item.get("children", [])])
    return item_text


def process_list_node(list_node: dict) -> str:
    list_type = list_node.get("listType", "bullet")  # Default to "bullet" if no type is provided
    markdown_output = []

    for index, item in enumerate(list_node.get("children", []), start=1):
        item_text = process_child(item)
        check = item.get("check", False)  # Default to False if "check" is missing

        if list_type == "number":
            markdown_output.append(f"{index}. {item_text}")
        elif list_type == "bullet":
            markdown_output.append(f"- {item_text}")
        elif list_type == "check":
            checkbox = "[x]" if check else "[ ]"
            markdown_output.append(f"{checkbox} {item_text}")

    return "\n".join(markdown_output)


def process_table_cell(table_cell: dict) -> str:
    return "\n\n".join([process_child(child) for child in table_cell.get("children", [])])


def process_table_row(table_row: dict) -> str:
    return "| " + " | ".join([process_child(cell) for cell in table_row.get("children", [])]) + " |"


def process_table_node(table_node: dict) -> str:
    table_markdown = []
    for row in table_node.get("children", []):
        table_markdown.append(process_child(row))

    # Add Markdown table header separator after the first row if it's a table with headers
    if table_markdown:
        num_columns = len(table_markdown[0].split("|")) - 2  # Subtracting 2 to account for empty splits at the ends
        header_separator = "| " + " | ".join(["---"] * num_columns) + " |"
        table_markdown.insert(1, header_separator)

    return "\n".join(table_markdown)


def process_heading_node(heading_node: dict) -> str:
    heading_text = "".join([process_child(child) for child in heading_node.get("children", [])])
    heading_tag = heading_node.get("tag", "h1")
    heading_level = int(heading_tag[1])
    return f"{'#' * heading_level} {heading_text}"


def process_linebreak_node(heading_node: dict) -> str:
    return "\n"


def process_horizontalrule_node(heading_node: dict) -> str:
    return "---"


def process_quote_node(quote_node: dict) -> str:
    quote_text = "".join([process_child(child) for child in quote_node.get("children", [])])
    return f"> {quote_text}"


def process_hashtag_node(hashtag_node: dict) -> str:
    return f"#{hashtag_node.get('text', '')}"


def process_link_node(link_node: dict) -> str:
    url = link_node.get("url", "")
    link_text = "".join([process_child(child) for child in link_node.get("children", [])])
    return f"[{link_text}]({url})"


def process_emoji_node(emoji_node: dict) -> str:
    return emoji_node.get("emoji", "")


def process_collapsible_node(collapsible_node: dict):
    collapsible_children = collapsible_node.get("children", [])
    if not len(collapsible_children) == 2:
        logging.warning("Collapsible container must have exactly 2 children")
        return ""

    title = ""
    content = ""
    for collapsible_child in collapsible_children:
        if collapsible_child.get("type") == "collapsible-title":
            title = "".join([process_child(child) for child in collapsible_child.get("children", [])])
        elif collapsible_child.get("type") == "collapsible-content":
            content = "".join([process_child(child) for child in collapsible_child.get("children", [])])
        else:
            logging.warning("Collapsible container children must be collapsible-title and collapsible-content")
            return ""

    return f"<details>\n<summary>{title}</summary>\n{content}\n</details>"


def process_hinted_node(hinted_node: dict):
    hinted_children = hinted_node.get("children", [])
    if not len(hinted_children) == 2:
        logging.warning("Hinted must have exactly 2 children")
        return ""

    hint = ""
    content = ""
    for hinted_child in hinted_children:
        if hinted_child.get("type") == "hint":
            hint = "".join([process_child(child) for child in hinted_child.get("children", [])])
        elif hinted_child.get("type") == "hinted-content":
            content = "".join([process_child(child) for child in hinted_child.get("children", [])])
        else:
            logging.warning("Hinted children must be hint and hinted-content")
            return ""
    return f"[[[HINT: {hint}]]]\n{content}"


def process_child(child: dict) -> str:
    if child.get("type") == "text":
        return process_text_node(child)
    elif child.get("type") == "paragraph":
        return process_paragraph_node(child)
    elif child.get("type") == "fence":
        return process_fence_node(child)
    elif child.get("type") == "list":
        return process_list_node(child)
    elif child.get("type") == "listitem":
        return process_listitem_node(child)
    elif child.get("type") == "table":
        return process_table_node(child)
    elif child.get("type") == "tablerow":
        return process_table_row(child)
    elif child.get("type") == "tablecell":
        return process_table_cell(child)
    elif child.get("type") == "heading":
        return process_heading_node(child)
    elif child.get("type") == "linebreak":
        return process_linebreak_node(child)
    elif child.get("type") == "horizontalrule":
        return process_horizontalrule_node(child)
    elif child.get("type") == "quote":
        return process_quote_node(child)
    elif child.get("type") == "hashtag":
        return process_hashtag_node(child)
    elif child.get("type") == "link":
        return process_link_node(child)
    elif child.get("type") == "emoji":
        return process_emoji_node(child)
    elif child.get("type") == "collapsible-container":
        return process_collapsible_node(child)
    elif child.get("type") == "hinted":
        return process_hinted_node(child)
    elif child.get("type") == "chat":
        # ignoring chat nodes
        return ""
    else:
        logging.warning(f"Unknown node type: {child.get('type')}")
        return ""


def lexical_to_markdown(data: dict) -> str:
    root = data.get("root", {})
    return "\n\n".join([process_child(child) for child in root.get("children", [])])
