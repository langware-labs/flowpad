import hashlib
import re
import textwrap
import warnings
import xml.etree.ElementTree as ET
from dataclasses import asdict, dataclass, is_dataclass
from datetime import date
from typing import Any, Callable, Dict, Iterable, Iterator, List, Mapping, Optional, Type, Union, get_args, get_origin

import mcp
import regex
from pydantic import BaseModel, TypeAdapter

from flow_sdk.config import default_service_config
from flow_sdk.external_apis.llm.llm_drivers.definitions import LLMMessage
from flow_sdk.external_apis.llm.utils.best_effort_json_parser import (
    parse as best_effort_parse,
)
from flow_sdk.utils import type_safe_json_dumps


def generate_hash(prompt):
    return hashlib.md5(prompt.encode()).hexdigest()


def sanitize_filename(filename):
    return re.sub(r'[<>:"/\\|?*]', "_", filename)


def clean_json_completion(text):
    # This regex pattern aims to match any JSON wrapped with {} or [],
    # and accounts for nested objects and arrays.
    # It assumes the JSON is correctly formatted and doesn't validate the JSON content.
    pattern = r"(\{(?:[^{}]*|(?1))*\}|\[(?:[^\[\]]*|(?1))*\])"
    match = regex.search(pattern, text)
    if match is None:
        return best_effort_parse(text)
    return best_effort_parse(match.group(0))


def clean_fenced_completion(text: str):
    # First try to find JSON within complete code fences (with both opening and closing)
    # Handle closing fence with optional whitespace
    fenced_match = re.search(r"```(?:json|markdown)?\s*\n(.*?)\n\s*```", text, flags=re.DOTALL)
    if fenced_match:
        return fenced_match.group(1).strip()

    # Try to match incomplete fences (opening fence without closing)
    incomplete_match = re.search(r"```(?:json|markdown)?\s*\n(.*)", text, flags=re.DOTALL)
    if incomplete_match:
        content = incomplete_match.group(1)
        # Remove any trailing backticks that might be partial closures
        content = re.sub(r"```+\s*$", "", content)
        return content.strip()

    # If no fenced code, try to extract JSON object or array using regex module for recursive matching
    # This pattern matches balanced braces/brackets
    pattern = r"(\{(?:[^{}]*|(?1))*\}|\[(?:[^\[\]]*|(?1))*\])"
    json_match = regex.search(pattern, text)
    if json_match:
        return json_match.group(0).strip()

    # Fallback to original behavior - remove fences if they wrap the entire content
    cleaned_text = re.sub(r"^```.*?\n(.*?)(?:```)?$", r"\1", text.strip(), flags=re.DOTALL).strip()
    return cleaned_text.strip()


def cast_to_type(data: Any, type_hint: Type, union_discriminator: Optional[Callable] = None) -> Any:
    """
    Casts the given data to the specified type_hint. Supports complex, nested types involving Pydantic models.
    """
    # If the type hint is a list, tuple, or set, recursively cast each item
    origin_type = get_origin(type_hint)
    if origin_type in (list, tuple, set) and origin_type is not None:
        item_type = get_args(type_hint)[0]
        return origin_type(cast_to_type(item, item_type, union_discriminator) for item in data)

    # If the type hint is a dict, recursively cast each value (assuming str keys)
    if origin_type is dict:
        key_type, value_type = get_args(type_hint)
        return {
            cast_to_type(key, key_type, union_discriminator): cast_to_type(value, value_type, union_discriminator)
            for key, value in data.items()
        }

    # For Union types, try each until one succeeds
    # Handling Union types with or without a discriminator
    if origin_type is Union:
        union_types = get_args(type_hint)
        if union_discriminator:
            selected_type = union_discriminator(data, union_types)
            return cast_to_type(data, selected_type, union_discriminator)
        else:
            if len(union_types) > 1:
                warnings.warn(
                    "Casting to Union types without discriminator is not recommended, as it produces ambiguity"
                )
            for union_type in union_types:
                try:
                    return cast_to_type(data, union_type, union_discriminator)
                except (TypeError, ValueError):
                    continue
            raise ValueError("Data does not match any type in Union")

    # If the type hint is a Pydantic model, use validate_python directly
    if issubclass(type_hint, BaseModel):
        return TypeAdapter(type_hint).validate_python(data)

    # If it's not a complex type, return the data as is (or you could add more specific cases)
    return data


def typed_messages(
    input_schema: Dict[str, Any],
    output_schema: Dict[str, Any],
    input_data: Any,
    instruction: str = "",
) -> List[LLMMessage]:
    system_prompt = (
        textwrap.dedent("""
        {instruction}
        - You will be given input conforming to the following json schema:
        ### INPUT JSON SCHEMA START ###
        {input_schema}
        ### INPUT JSON SCHEMA END ###
        - You must provide an answer conforming to following json schema:
        ### OUTPUT JSON SCHEMA START ###
        {output_schema}
        ### OUTPUT JSON SCHEMA END ###
        """)
        .strip()
        .format(
            instruction=instruction,
            input_schema=type_safe_json_dumps(input_schema, indent=default_service_config.json_indent_level),
            output_schema=type_safe_json_dumps(output_schema, indent=default_service_config.json_indent_level),
        )
    )

    if isinstance(input_data, str):
        user_prompt = input_data
    else:
        user_prompt = type_safe_json_dumps(
            input_data,
            indent=default_service_config.json_indent_level,
        )

    return [
        LLMMessage(role="system", content=system_prompt),
        LLMMessage(role="user", content=user_prompt),
    ]


# Taken as is from pydantic_ai.format_as_xml
def format_as_xml(
    obj: Any,
    root_tag: str = "examples",
    item_tag: str = "example",
    include_root_tag: bool = True,
    none_str: str = "null",
    indent: str | None = "  ",
) -> str:
    """Format a Python object as XML.

    This is useful since LLMs often find it easier to read semi-structured data (e.g. examples) as XML,
    rather than JSON etc.

    Supports: `str`, `bytes`, `bytearray`, `bool`, `int`, `float`, `date`, `datetime`, `Mapping`,
    `Iterable`, `dataclass`, and `BaseModel`.

    Args:
        obj: Python Object to serialize to XML.
        root_tag: Outer tag to wrap the XML in, use `None` to omit the outer tag.
        item_tag: Tag to use for each item in an iterable (e.g. list), this is overridden by the class name
            for dataclasses and Pydantic models.
        include_root_tag: Whether to include the root tag in the output
            (The root tag is always included if it includes a body - e.g. when the input is a simple value).
        none_str: String to use for `None` values.
        indent: Indentation string to use for pretty printing.

    Returns:
        XML representation of the object.

    Example:
    ```python {title="format_as_xml_example.py" lint="skip"}
    from pydantic_ai.format_as_xml import format_as_xml

    format_as_xml({'name': 'John', 'height': 6, 'weight': 200}, root_tag='user')
    '''
    <user>
      <name>John</name>
      <height>6</height>
      <weight>200</weight>
    </user>
    '''
    ```
    """
    el = _ToXml(item_tag=item_tag, none_str=none_str).to_xml(obj, root_tag)
    if not include_root_tag and el.text is None:
        join = "" if indent is None else "\n"
        return join.join(_rootless_xml_elements(el, indent))
    else:
        if indent is not None:
            ET.indent(el, space=indent)
        return ET.tostring(el, encoding="unicode")


@dataclass
class _ToXml:
    item_tag: str
    none_str: str

    def to_xml(self, value: Any, tag: str | None) -> ET.Element:
        element = ET.Element(self.item_tag if tag is None else tag)
        if value is None:
            element.text = self.none_str
        elif isinstance(value, str):
            element.text = value
        elif isinstance(value, (bytes, bytearray)):
            element.text = value.decode(errors="ignore")
        elif isinstance(value, (bool, int, float)):
            element.text = str(value)
        elif isinstance(value, date):
            element.text = value.isoformat()
        elif isinstance(value, Mapping):
            self._mapping_to_xml(element, value)  # pyright: ignore[reportUnknownArgumentType]
        elif is_dataclass(value) and not isinstance(value, type):
            if tag is None:
                element = ET.Element(value.__class__.__name__)
            dc_dict = asdict(value)
            self._mapping_to_xml(element, dc_dict)
        elif isinstance(value, BaseModel):
            if tag is None:
                element = ET.Element(value.__class__.__name__)
            self._mapping_to_xml(element, value.model_dump(mode="python"))
        elif isinstance(value, Iterable):
            for item in value:  # pyright: ignore[reportUnknownVariableType]
                item_el = self.to_xml(item, None)
                element.append(item_el)
        else:
            raise TypeError(f"Unsupported type for XML formatting: {type(value)}")
        return element

    def _mapping_to_xml(self, element: ET.Element, mapping: Mapping[Any, Any]) -> None:
        for key, value in mapping.items():
            if isinstance(key, int):
                key = str(key)
            elif not isinstance(key, str):
                raise TypeError(f"Unsupported key type for XML formatting: {type(key)}, only str and int are allowed")
            element.append(self.to_xml(value, key))


def _rootless_xml_elements(root: ET.Element, indent: str | None) -> Iterator[str]:
    for sub_element in root:
        if indent is not None:
            ET.indent(sub_element, space=indent)
        yield ET.tostring(sub_element, encoding="unicode")


def mcp_tool_input_schema(tool: mcp.Tool) -> dict[str, Any]:
    input_schema = tool.inputSchema
    if "description" not in input_schema:
        input_schema["description"] = tool.description
    if "title" not in input_schema:
        input_schema["title"] = tool.name
    return input_schema


def find_links_in_text(text: str) -> list[str]:
    url_extract_pattern = "https?:\\/\\/(?:www\\.)?[-a-zA-Z0-9@:%._\\+~#=]{1,256}\\.[a-zA-Z0-9()]{1,6}\\b(?:[-a-zA-Z0-9()@:%_\\+.~#?&\\/=]*)"
    return re.findall(url_extract_pattern, text)
