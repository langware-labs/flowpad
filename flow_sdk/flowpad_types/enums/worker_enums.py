from enum import Enum


class WorkerType(str, Enum):
    AUTO = "auto"
    PYDANTIC_AI = "pydantic_ai"
    CLAUDE_CODE = "claude_code"
    CLAUDE_CODE_CLI = "claude_code_cli"
    UNSECURED_CLAUDE = "unsecured_claude"
    CODEX = "codex"
    COPILOT = "copilot"
    SIMPLE = "simple"
    MOCK = "mock"


class WorkerTaskStatus(str, Enum):
    """Status of a worker task execution."""

    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class WorkerCapability(str, Enum):
    """Capabilities that a worker can provide."""

    SIMPLE_TEXT_GENERATION = "simple_text_generation"
    TOOL_EXECUTION = "tool_execution"
    XML_PROCESSING = "xml_processing"
    SEARCH_AND_FETCH = "search_and_fetch"
    FILE_OPERATIONS = "file_operations"
    SHELL_COMMANDS = "shell_commands"
    CODE_GENERATION = "code_generation"
    REASONING = "reasoning"
