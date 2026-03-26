import base64
import html
import json
import random
import re
import time
from datetime import datetime, timezone
from flow_sdk._compat import StrEnum
from typing import Any, ClassVar, Optional

from pydantic import BaseModel, computed_field


def _escape_xml_attribute(value: str) -> str:
    """Safely escape XML attribute values to prevent injection attacks."""
    if not isinstance(value, str):
        value = str(value)

    # Remove null bytes and other control characters that can break XML
    value = re.sub(r"[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]", "", value)

    # HTML escape for XML safety
    value = html.escape(value, quote=True)

    # Additional XML-specific escaping
    value = value.replace("\n", "&#10;").replace("\r", "&#13;").replace("\t", "&#9;")

    return value


def _escape_xml_content(content: str) -> str:
    """Safely escape XML content to prevent injection attacks."""
    if not isinstance(content, str):
        content = str(content)

    # Remove null bytes and other control characters
    content = re.sub(r"[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]", "", content)

    # HTML escape for XML safety (but allow newlines in content)
    content = html.escape(content, quote=False)

    return content


def _validate_element_type(element_type: str) -> str:
    """Validate and sanitize element type to prevent injection."""
    if not isinstance(element_type, str):
        element_type = str(element_type)

    # Only allow alphanumeric, hyphen, and underscore
    element_type = re.sub(r"[^a-zA-Z0-9_-]", "", element_type)

    # Ensure it starts with a letter
    if not element_type or not element_type[0].isalpha():
        element_type = "result"

    return element_type


class FlowDataType(StrEnum):
    TEXT = "string"
    OBJECT = "object"
    ENTITY = "entity"


class ViewType(StrEnum):
    CHAT = "chat"
    SHELL = "shell"
    EDITOR = "editor"
    WEB_APP = "web-app"
    ENVIRONMENT = "environment"
    CONNECTIONS = "connections"
    ARTIFACTS = "artifacts"
    TRACE = "trace"
    REASONING = "reasoning"
    DIFF = "diff"
    UNSUPPORTED = "unsupported"
    MARKDOWN = "markdown"
    DOCS = "docs"
    ASSISTANCE = "assistance"
    SURVEY = "survey"


class SurveyType(StrEnum):
    """Supported survey types for flow-survey element."""

    SURVEYJS = "surveyjs"


class UserMessageType(StrEnum):
    """User message types for distinguishing regular text from survey responses."""

    TEXT = "text"
    SURVEY_RESULT = "survey_result"


class FlowElementType(StrEnum):
    """Centralized definition of all flow element types."""

    UNKNOWN = "unknown"
    REASONING = "reasoning"
    CHAT = "chat"
    ERROR = "error"
    LLM_END = "llm-end"
    END = "end"
    STATUS = "status"
    MODE = "mode"  # DEPRECATED: Use STATE with key="current_mode" instead
    CHECKPOINT = "checkpoint"
    TRACE = "trace"
    SOURCE = "source"
    RESULT = "result"
    STATE = "state"
    USER_MESSAGE = "user-message"
    PROMPT_ECHO = "prompt-echo"
    FOCUS = "focus"
    SHELL_INPUT = "shell-input"
    SHELL_OUTPUT = "shell-output"
    CACHED_MESSAGE = "cached-message"
    GOAL = "goal"  # DEPRECATED: Use STATE with key="goal" instead
    TODO = "todo"  # DEPRECATED: Use STATE with key="root_todo" instead
    PHASE = "phase"  # DEPRECATED: Use STATE with key="flow_phase" instead
    PROMPT_ANALYSIS = "prompt_analysis"  # DEPRECATED: Use STATE with key="user_prompt_analysis" instead
    WEB_APP = "web-app"
    SURVEY = "survey"
    WRITE = "write"
    CONTINUE = "continue"
    TOOL_CALL = "tool-call"
    TOOL_RESULT = "tool-result"

    @classmethod
    def streamable_types(cls) -> set[str]:
        """Return set of element types that support streaming consolidation.

        These types can accumulate content without closing/reopening tags,
        reducing bandwidth and parsing overhead by 30-50%.
        """
        return {
            cls.REASONING,
            cls.CHAT,
            cls.SHELL_OUTPUT,
            cls.TRACE,
            cls.CACHED_MESSAGE,
        }


class FlowData(BaseModel):
    """Model for LLM data with structured data and attributes."""

    model_config = {"arbitrary_types_allowed": True}

    flow_value: Any = {}
    attributes: dict[str, str] = {}
    index: Optional[int] = None  # Auto-generated in __init__ if not provided
    part: Optional[int] = 0  # For chunked data parts
    created_time: str = ""  # ISO 8601 timestamp
    focus: Optional[ViewType] = None  # Focus recommendation for UI (e.g., "editor", "shell", "chat")
    _FLOW_DATA_NEXT_INDEX: ClassVar[int] = 0

    def __init__(self, **data):
        # Auto-generate index if not provided
        if "index" not in data or data.get("index") is None:
            data["index"] = FlowData._FLOW_DATA_NEXT_INDEX
            FlowData._FLOW_DATA_NEXT_INDEX += 1

        if "created_time" not in data or not data["created_time"]:
            data["created_time"] = datetime.now(timezone.utc).isoformat()

        super().__init__(**data)
        # Set default data-type attribute if not provided
        if "data-type" not in self.attributes:
            self.attributes["data-type"] = FlowDataType.OBJECT
        # Set default element-type if not provided
        if "element-type" not in self.attributes:
            self.attributes["element-type"] = FlowElementType.UNKNOWN

    @computed_field
    @property
    def data_type(self) -> Optional[FlowDataType]:
        """Get the data-type from attributes, returns None if not set."""
        data_type_value = self.attributes.get("data-type")
        if data_type_value is None:
            return None
        try:
            return FlowDataType(data_type_value)
        except ValueError:
            return None

    @data_type.setter
    def data_type(self, value: FlowDataType) -> None:
        """Set the data-type attribute."""
        self.attributes["data-type"] = value

    @computed_field
    @property
    def final(self) -> bool:
        if "final" in self.attributes:
            return self.attributes["final"].lower() == "true"
        return False

    @computed_field
    @property
    def group_id(self) -> str | None:
        if "group-id" not in self.attributes:
            return None
        return self.attributes["group-id"]

    @computed_field
    @property
    def channel(self) -> str | None:
        if "channel" not in self.attributes:
            return None
        return self.attributes["channel"]

    @computed_field
    @property
    def element_type(self) -> Optional[str]:
        """Get the element-type from attributes, returns None if not set."""
        return self.attributes.get("element-type")

    @element_type.setter
    def element_type(self, value: str) -> None:
        """Set the element-type attribute."""
        self.attributes["element-type"] = value

    @computed_field
    @property
    def to_xml(self) -> str:
        """Return canonical XML representation of this FlowData with security escaping."""
        # Validate and sanitize element type
        elem_type = _validate_element_type(self.element_type or "result")

        # Build attribute string with proper escaping (excluding element-type, including index as 'i' and timestamp as 't')
        attrs = [f'i="{_escape_xml_attribute(str(self.index))}"']  # Always include index first
        if self.created_time:
            attrs.append(f't="{_escape_xml_attribute(self.created_time)}"')  # Include timestamp
        if self.focus:
            attrs.append(f'focus="{_escape_xml_attribute(self.focus)}"')  # Include focus if present
        if self.part and self.part > 0:
            attrs.append(f'part="{_escape_xml_attribute(str(self.part))}"')
        for key, value in self.attributes.items():
            if key != "element-type":
                # Sanitize attribute name and escape value
                safe_key = re.sub(r"[^a-zA-Z0-9_-]", "", str(key))
                if safe_key and safe_key[0].isalpha():  # Valid attribute name
                    safe_value = _escape_xml_attribute(str(value))
                    attrs.append(f'{safe_key}="{safe_value}"')
        attr_str = " " + " ".join(attrs)

        # Format content based on data_type with security escaping
        if self.data_type == FlowDataType.ENTITY:
            if not hasattr(self.flow_value, "model_dump_json"):
                content = json.dumps({"error": "flow_value must be an Entity for data_type 'entity'"})
            else:
                try:
                    content = self.flow_value.model_dump_json()
                except Exception as e:
                    content = json.dumps({"error": f"Entity serialization failed: {str(e)}"})
            # JSON content should be escaped for XML
            content = _escape_xml_content(content)
        elif self.data_type == FlowDataType.OBJECT:
            # Object: JSON stringify with error handling
            try:
                content = json.dumps(self.flow_value)
            except (TypeError, ValueError) as e:
                content = json.dumps({"error": f"JSON serialization failed: {str(e)}"})
            # JSON content should be escaped for XML
            content = _escape_xml_content(content)
        else:
            # String or other: escape for XML safety
            content = _escape_xml_content(str(self.flow_value))

        element_xml = f"<flow-{elem_type}{attr_str}>{content}</flow-{elem_type}>\n"
        return element_xml

    @computed_field
    @property
    def start_tag_xml(self) -> str:
        """Return opening XML tag for streaming with security escaping."""
        # Validate and sanitize element type
        elem_type = _validate_element_type(self.element_type or "result")

        # Build attribute string with proper escaping (excluding element-type, including index as 'i' and timestamp as 't')
        attrs = [f'i="{_escape_xml_attribute(str(self.index))}"']  # Always include index first
        if self.created_time:
            attrs.append(f't="{_escape_xml_attribute(self.created_time)}"')  # Include timestamp
        if self.focus:
            attrs.append(f'focus="{_escape_xml_attribute(self.focus)}"')  # Include focus if present
        for key, value in self.attributes.items():
            if key != "element-type":
                # Sanitize attribute name and escape value
                safe_key = re.sub(r"[^a-zA-Z0-9_-]", "", str(key))
                if safe_key and safe_key[0].isalpha():  # Valid attribute name
                    safe_value = _escape_xml_attribute(str(value))
                    attrs.append(f'{safe_key}="{safe_value}"')
        attr_str = " " + " ".join(attrs) if attrs else ""

        return f"<flow-{elem_type}{attr_str}>"

    @computed_field
    @property
    def content(self) -> str:
        """Return content portion for streaming with security escaping."""
        # Format content based on data_type with security escaping
        if self.data_type == FlowDataType.ENTITY:
            if not hasattr(self.flow_value, "model_dump_json"):
                content = json.dumps({"error": "flow_value must be an Entity for data_type 'entity'"})
            else:
                try:
                    content = self.flow_value.model_dump_json()
                except Exception as e:
                    content = json.dumps({"error": f"Entity serialization failed: {str(e)}"})
            # JSON content should be escaped for XML
            return _escape_xml_content(content)
        elif self.data_type == FlowDataType.OBJECT:
            # Object: JSON stringify with error handling
            try:
                content = json.dumps(self.flow_value)
            except (TypeError, ValueError) as e:
                content = json.dumps({"error": f"JSON serialization failed: {str(e)}"})
            # JSON content should be escaped for XML
            return _escape_xml_content(content)
        else:
            # String or other: escape for XML safety
            return _escape_xml_content(str(self.flow_value))

    @computed_field
    @property
    def end_tag_xml(self) -> str:
        """Return closing XML tag for streaming with security validation."""
        # Validate and sanitize element type
        elem_type = _validate_element_type(self.element_type or "result")
        return f"</flow-{elem_type}>\n"

    def set_flow_value(self, value: Any) -> "FlowData":
        """Set flow_value and return self for chaining."""
        self.flow_value = value
        return self

    def set_attribute(self, key: str, value: str) -> "FlowData":
        """Set attribute and return self for chaining."""
        self.attributes[key] = value
        return self

    def set_data_type(self, data_type: FlowDataType) -> "FlowData":
        """Set the data-type attribute and return self for chaining."""
        self.attributes["data-type"] = data_type
        return self

    def set_element_type(self, element_type: str) -> "FlowData":
        """Set the element-type attribute and return self for chaining."""
        self.attributes["element-type"] = element_type
        return self

    def generate_group_id(self) -> str:
        """
        Generate a unique group-id for this FlowData and set it in attributes.
        Uses base64 encoding of timestamp + random value to create 8-char ID.

        The group-id is used by FlowStreamProcessor to merge streaming FlowData chunks
        that belong to the same logical group (e.g., stdout/stderr/exit-code for a command).

        Returns:
            The generated group_id string.
        """
        group_id = base64.b64encode(f"{time.time()}{random.random()}".encode())[:8].decode("utf-8")
        self.attributes["group-id"] = group_id
        return group_id

    def set_group_id(self, group_id: str) -> "FlowData":
        """
        Set the group-id attribute and return self for chaining.

        Args:
            group_id: The group ID to set

        Returns:
            self for method chaining
        """
        self.attributes["group-id"] = group_id
        return self

    def matches(self, other: "FlowData") -> bool:
        """
        Compare this FlowData with another for equality.
        Tests all attributes, values, and element types.
        """
        if not isinstance(other, FlowData):
            return False

        # Compare element types
        if self.element_type != other.element_type:
            return False

        # Compare data types
        if self.data_type != other.data_type:
            return False

        # Compare flow values
        if self.flow_value != other.flow_value:
            return False

        # Compare attributes (excluding index and timestamp for consolidation compatibility)
        self_attrs = {k: v for k, v in self.attributes.items() if k not in ("index", "t")}
        other_attrs = {k: v for k, v in other.attributes.items() if k not in ("index", "t")}

        if self_attrs != other_attrs:
            return False

        return True

    def __repr__(self):
        return f"FlowData({self.element_type}, {self.data_type}, {self.flow_value[:10]}..., index={self.index})"


class FlowCheckpointData(FlowData):
    """FlowData subclass specifically for checkpoint data with convenience methods."""

    @property
    def checkpoint_hash(self) -> str:
        """Get checkpoint_hash from attributes."""
        return self.attributes.get("checkpoint_hash", "")

    # noinspection PyArgumentList
    @classmethod
    def create(cls, checkpoint_hash: str) -> "FlowCheckpointData":
        """Create a FlowCheckpointData instance with proper attributes."""
        return cls(
            flow_value="",
            attributes={
                "element-type": FlowElementType.CHECKPOINT,
                "data-type": FlowDataType.TEXT.value,
                "checkpoint_hash": checkpoint_hash,
            },
        )
