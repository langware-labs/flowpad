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
    # Config-owning agents that aren't executors FlowPad spawns, but DO own MCP
    # server config files the indexer reads. Used as the source-agent tag on
    # MCP_SERVER records (see fs_store/indexer/functions/mcp_server.py).
    CURSOR = "cursor"
    WINDSURF = "windsurf"
    VSCODE = "vscode"
    CLAUDE_DESKTOP = "claude_desktop"


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
