"""System profile types for Claude Code environment information."""

from pydantic import BaseModel, Field

from flow_sdk._compat import StrEnum


class Scope(StrEnum):
    """Scope/location of a configuration item."""

    MANAGED = "managed"  # /Library/Application Support/ClaudeCode/
    USER = "user"  # ~/.claude/
    GLOBAL = "global"  # ~/.claude/ (alias for user)
    PROJECT = "project"  # .claude/
    LOCAL = "local"  # .claude/*.local.*
    LEGACY = "legacy"  # ~/.claude.json
    PLUGIN = "plugin"  # ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/


class ItemType(StrEnum):
    """Type of system profile item (similar to entity.type)."""

    PLUGIN = "plugin"
    MARKETPLACE = "marketplace"
    HOOK = "hook"
    MCP_SERVER = "mcp_server"
    AGENT = "agent"
    COMMAND = "command"
    CLAUDE_MD = "claude_md"
    PROJECT = "project"
    CLAUDE_SESSION = "claude_session"
    PLAN = "plan"
    DIRECTORY = "directory"
    GITHUB_REPO = "github_repo"
    SKILL = "skill"
    TODO_FILE = "todo_file"


# ===================================================================
# BASE CLASS - Entity-like structure for all items
# ===================================================================


class SystemProfileItem(BaseModel):
    """
    Base class for all system profile items.
    Implements IResource interface for unified resource management.

    Key fields (IResource):
    - id: Unique identifier (correlates with entity.id if promoted)
    - type: Type discriminator (like entity.type)
    - name: Display name
    - created_at/modified_at: Timestamps (ISO strings)
    - created_by/updated_by: User/agent identifiers

    SystemProfileItem-specific:
    - scope: Location scope (user/project/local/managed/etc)
    - source_file: Where this item is defined
    - path: Full path to file-based item
    - entity_id: Links to Entity.id if resource is promoted to entity
    """

    # IResource fields
    id: str = Field(description="Unique ID (correlates with entity.id if promoted)")
    type: str = Field(description="Type discriminator (e.g., 'hook', 'mcp_server')")
    name: str = Field(description="Display name")
    created_at: str | None = Field(default=None, description="Creation timestamp (ISO string)")
    modified_at: str | None = Field(default=None, description="Last modified timestamp (ISO string)")
    created_by: str | None = Field(default=None, description="User/agent who created this resource")
    updated_by: str | None = Field(default=None, description="User/agent who last modified this resource")

    # SystemProfileItem-specific fields
    scope: str = Field(default=Scope.USER.value, description="Scope: user/project/local/managed/etc")
    source_file: str | None = Field(default=None, description="Source file path")
    path: str | None = Field(default=None, description="Full path to item")
    entity_id: str | None = Field(default=None, description="Links to Entity.id if promoted to entity")


# ===================================================================
# DERIVED ITEM CLASSES - All inherit from SystemProfileItem
# ===================================================================


class PluginItem(SystemProfileItem):
    """Plugin - inherits IResource fields plus plugin-specific fields."""

    type: str = Field(default=ItemType.PLUGIN.value)
    version: str = Field(default="")
    marketplace: str | None = Field(default=None, description="Plugin marketplace source")
    enabled: bool = Field(default=True)
    plugin_key: str | None = Field(default=None, description="Composite key: name@marketplace")


class MarketplaceItem(SystemProfileItem):
    """Marketplace - inherits IResource fields plus marketplace-specific fields."""

    type: str = Field(default=ItemType.MARKETPLACE.value)
    source: str = Field(default="", description="Source type (github, etc.)")
    repo: str | None = Field(default=None)
    install_location: str | None = Field(default=None)


class HookItem(SystemProfileItem):
    """Hook - inherits IResource fields plus hook-specific fields."""

    type: str = Field(default=ItemType.HOOK.value)
    event_type: str = Field(default="", description="PreToolUse, PostToolUse, etc.")
    matcher: str = Field(default="*", description="Matcher pattern")
    command: str = Field(default="", description="Command to execute")
    hook_type: str = Field(default="command")
    plugin_name: str | None = Field(default=None, description="Plugin name if scope is plugin")


class McpServerItem(SystemProfileItem):
    """MCP Server - inherits IResource fields plus MCP-specific fields."""

    type: str = Field(default=ItemType.MCP_SERVER.value)
    command: str = Field(default="")
    args: list[str] = Field(default_factory=list)
    env: dict[str, str] = Field(default_factory=dict)


class AgentItem(SystemProfileItem):
    """Custom agent/subagent - inherits IResource fields."""

    type: str = Field(default=ItemType.AGENT.value)


class CommandItem(SystemProfileItem):
    """Custom slash command - inherits IResource fields."""

    type: str = Field(default=ItemType.COMMAND.value)


class ClaudeMdItem(SystemProfileItem):
    """CLAUDE.md instruction file - inherits IResource fields."""

    type: str = Field(default=ItemType.CLAUDE_MD.value)
    size: int = Field(default=0, description="File size in bytes")


class ProjectItem(SystemProfileItem):
    """Project - inherits IResource fields plus project-specific fields."""

    type: str = Field(default=ItemType.PROJECT.value)
    encoded_name: str = Field(default="", description="Folder name for correlation")
    cwd: str = Field(default="", description="Actual working directory")
    session_count: int = Field(default=0)
    total_messages: int = Field(default=0)



class PlanItem(SystemProfileItem):
    """Saved plan - inherits IResource fields plus plan-specific fields."""

    type: str = Field(default=ItemType.PLAN.value)
    size: int = Field(default=0, description="File size in bytes")
    size_formatted: str = Field(default="", description="Human readable")


class DirectoryItem(SystemProfileItem):
    """Directory info - inherits IResource fields plus directory-specific fields."""

    type: str = Field(default=ItemType.DIRECTORY.value)
    count: int | None = Field(default=None, description="Item count")
    description: str = Field(default="")
    exists: bool = Field(default=True)


class GitHubRepoItem(SystemProfileItem):
    """GitHub repo mapping - inherits IResource fields plus repo-specific fields."""

    type: str = Field(default=ItemType.GITHUB_REPO.value)
    paths: list[str] = Field(default_factory=list, description="Local paths")


class SkillItem(SystemProfileItem):
    """Skill - inherits IResource fields plus skill-specific fields."""

    type: str = Field(default=ItemType.SKILL.value)
    usage_count: int = Field(default=0)


class TodoEntry(BaseModel):
    """Individual todo item within a todo file."""

    content: str = Field(default="")
    status: str = Field(default="pending", description="pending, in_progress, or completed")
    activeForm: str = Field(default="")


class TodoFileItem(SystemProfileItem):
    """Todo file - contains todo entries from a session.

    Filename pattern: {session-id}-agent-{agent-id}.json
    """

    type: str = Field(default=ItemType.TODO_FILE.value)
    session_id: str = Field(default="", description="Session ID this todo file belongs to")
    agent_id: str = Field(default="", description="Agent ID (same as session_id for main agent)")
    is_sub_agent: bool = Field(default=False, description="Whether this is a sub-agent todo file")
    entry_count: int = Field(default=0, description="Number of todo entries in the file")
    completed_count: int = Field(default=0)
    pending_count: int = Field(default=0)
    in_progress_count: int = Field(default=0)
    entries: list[TodoEntry] = Field(default_factory=list, description="The actual todo entries")


# ===================================================================
# NON-ITEM MODELS (Summary, Account, etc.)
# ===================================================================


class TranscriptStats(BaseModel):
    """Aggregated transcript statistics across all sessions."""

    # Session counts
    sessions_analyzed: int = Field(default=0, description="Number of sessions analyzed")
    total_entries: int = Field(default=0, description="Total JSONL entries")
    total_size_bytes: int = Field(default=0, description="Total size of transcript files")

    # Token usage
    total_input_tokens: int = Field(default=0)
    total_output_tokens: int = Field(default=0)
    total_cache_read_tokens: int = Field(default=0)
    total_cache_creation_tokens: int = Field(default=0)

    # Cost estimation
    total_estimated_cost_usd: float = Field(default=0.0)
    cost_breakdown: dict[str, float] = Field(
        default_factory=dict, description="Cost breakdown: {input, output, cache_read, cache_write}"
    )
    savings_from_cache_usd: float = Field(default=0.0, description="Estimated savings from cache")

    # Model usage
    models_used: dict[str, int] = Field(default_factory=dict, description="Model -> response count")
    primary_model: str | None = Field(default=None)

    # Tool usage
    tools_used: dict[str, int] = Field(default_factory=dict, description="Tool -> usage count")
    total_tool_uses: int = Field(default=0)

    # Entry type breakdown
    entry_types: dict[str, int] = Field(default_factory=dict, description="Entry type -> count")

    # Content type breakdown
    content_types: dict[str, int] = Field(default_factory=dict, description="Content type -> count")

    # Service tier tracking
    service_tiers: dict[str, int] = Field(default_factory=dict, description="Service tier -> count")

    # Date range
    oldest_session_date: str | None = Field(default=None)
    newest_session_date: str | None = Field(default=None)


class SystemProfileSummary(BaseModel):
    """Aggregated counts - not an item."""

    totalProjects: int = Field(default=0)
    totalSessions: int = Field(default=0)
    totalPrompts: int = Field(default=0)
    installedPlugins: int = Field(default=0)
    marketplaces: int = Field(default=0)
    mcpServers: int = Field(default=0)
    customAgents: int = Field(default=0)
    hooksConfigured: int = Field(default=0)
    claudeMdFiles: int = Field(default=0)
    githubRepos: int = Field(default=0)
    todoFiles: int = Field(default=0)
    startups: int = Field(default=0)
    currentDirectory: str = Field(default="")


class AccountInfo(BaseModel):
    """Account info - not an item (singleton)."""

    loggedIn: bool = Field(default=False)
    email: str = Field(default="")
    displayName: str = Field(default="")
    organization: str = Field(default="")
    role: str = Field(default="")
    subscription: str = Field(default="")
    source: str = Field(default="~/.claude.json")


# ===================================================================
# MAIN RESPONSE MODEL
# ===================================================================


class SystemProfile(BaseModel):
    """
    Main response model with all items inheriting from SystemProfileItem.

    Key features:
    - All items implement IResource interface (id, type, name, created_at, modified_at, created_by, updated_by)
    - All items have scope for location tracking
    - All items have optional entity_id for linking to promoted entities
    - recentItems: Pre-computed list of latest N items by modified_at
    """

    generated: str = Field(description="Generation timestamp (ISO string)")
    machine: str = Field(default="", description="Machine hostname")

    # Summary and account (non-items)
    summary: SystemProfileSummary = Field(default_factory=SystemProfileSummary)
    account: AccountInfo = Field(default_factory=AccountInfo)

    # All items inherit from SystemProfileItem
    directories: list[DirectoryItem] = Field(default_factory=list)
    plugins: list[PluginItem] = Field(default_factory=list)
    marketplaces: list[MarketplaceItem] = Field(default_factory=list)
    hooks: list[HookItem] = Field(default_factory=list)
    mcpServers: list[McpServerItem] = Field(default_factory=list)
    agents: list[AgentItem] = Field(default_factory=list)
    commands: list[CommandItem] = Field(default_factory=list)
    claudeMdFiles: list[ClaudeMdItem] = Field(default_factory=list)
    plans: list[PlanItem] = Field(default_factory=list)
    projects: list[ProjectItem] = Field(default_factory=list)
    sessions: list[dict] = Field(default_factory=list)
    githubRepos: list[GitHubRepoItem] = Field(default_factory=list)
    skills: list[SkillItem] = Field(default_factory=list)
    todos: list[TodoFileItem] = Field(default_factory=list)

    # Pre-computed for "latest 10 things changed"
    recentItems: list[SystemProfileItem] = Field(default_factory=list)

    ideConnections: int = Field(default=0)

    # Transcript analysis (aggregated stats across all sessions)
    transcriptStats: TranscriptStats = Field(default_factory=TranscriptStats)

    def get_all_items(self) -> list[SystemProfileItem]:
        """Get all items as a flat list for querying."""
        return (
            list(self.directories)
            + list(self.plugins)
            + list(self.marketplaces)
            + list(self.hooks)
            + list(self.mcpServers)
            + list(self.agents)
            + list(self.commands)
            + list(self.claudeMdFiles)
            + list(self.plans)
            + list(self.projects)
            + list(self.sessions)
            + list(self.githubRepos)
            + list(self.skills)
            + list(self.todos)
        )

    def get_latest_items(self, n: int = 10) -> list[SystemProfileItem]:
        """Get latest N items sorted by modified_at."""
        all_items = self.get_all_items()
        sorted_items = sorted([i for i in all_items if i.modified_at], key=lambda x: x.modified_at or "", reverse=True)
        return sorted_items[:n]

    def find_by_id(self, resource_id: str) -> SystemProfileItem | None:
        """Find item by id for correlation with entity.id."""
        for item in self.get_all_items():
            if item.id == resource_id:
                return item
        return None
