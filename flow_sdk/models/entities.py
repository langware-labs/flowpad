"""Pydantic model entities for flow-sdk.

This module imports entity models to trigger __init_subclass__ registration
with the type_registry. Imported by loaders module at startup.
"""

# Import core entity models needed for minihub
# Some modules have complex dependencies - import with try/except

# Core entities that should work
try:
    from flow_sdk.builtin.visitor import Visitor  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import Visitor: {e}")

try:
    from flow_sdk.builtin.user import User  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import User: {e}")

try:
    from flow_sdk.builtin.project import Project  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import Project: {e}")

try:
    from flow_sdk.builtin.wiki import Wiki, WikiEntry  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import Wiki entities: {e}")

try:
    from flow_sdk.builtin.secret_origin import SecretOrigin  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import SecretOrigin: {e}")

try:
    from flow_sdk.builtin.workspace import Workspace  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import Workspace: {e}")

try:
    from flow_sdk.builtin.organization import Organization  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import Organization: {e}")

try:
    from flow_sdk.builtin.team import Team  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import Team: {e}")

try:
    from flow_sdk.builtin.subagent import SubAgent  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import SubAgent: {e}")

try:
    from flow_sdk.builtin.api_key import ApiKey  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import ApiKey: {e}")

try:
    from flow_sdk.builtin.compute_node import ComputeNode  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import ComputeNode: {e}")

try:
    from flow_sdk.builtin.capability import Capability  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import Capability: {e}")

# Flow entity
# Agentic process entity
try:
    from flow_sdk.builtin.agentic_process import AgenticProcess  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import AgenticProcess entity: {e}")

try:
    from flow_sdk.builtin.bookmark import Bookmark  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import Bookmark: {e}")

try:
    from flow_sdk.builtin.graph_context import GraphContext  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import GraphContext: {e}")

try:
    from flow_sdk.builtin.contact_permission import ContactPermission  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import ContactPermission: {e}")

try:
    from flow_sdk.builtin.annotation import Annotation  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import Annotation: {e}")

try:
    from flow_sdk.builtin.shell import Shell  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import Shell: {e}")

try:
    from flow_sdk.builtin.collaboration_room import CollaborationRoom  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import CollaborationRoom: {e}")

try:
    from flow_sdk.builtin.remote_worker_session import RemoteWorkerSession  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import RemoteWorkerSession: {e}")

try:
    from flow_sdk.builtin.prompt_completion import PromptCompletion  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import PromptCompletion: {e}")

try:
    from flow_sdk.builtin.cron_event import CronEvent  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import CronEvent: {e}")

try:
    from flow_sdk.builtin.skill import Skill  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import Skill: {e}")

try:
    from flow_sdk.builtin.whiteboard import Whiteboard  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import Whiteboard: {e}")

try:
    from flow_sdk.builtin.deck_template import DeckTemplate  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import DeckTemplate: {e}")

try:
    from flow_sdk.builtin.deck import Deck  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import Deck: {e}")

try:
    from flow_sdk.builtin.spreadsheet import Spreadsheet  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import Spreadsheet: {e}")

try:
    from flow_sdk.builtin.group import Group  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import Group: {e}")

try:
    from flow_sdk.builtin.contacts_group import ContactsGroup  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import ContactsGroup: {e}")

try:
    from flow_sdk.builtin.tag import Tag  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import Tag: {e}")

try:
    from flow_sdk.builtin.prompt import Prompt  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import Prompt: {e}")

try:
    from flow_sdk.builtin.flowpad_diagnosis import FlowpadDiagnosis  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import FlowpadDiagnosis: {e}")

try:
    from flow_sdk.builtin.feed_entry import FeedEntry  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import FeedEntry: {e}")

try:
    from flow_sdk.builtin.graph_workflow_node import GraphWorkflowNode  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import GraphWorkflowNode: {e}")

try:
    from flow_sdk.builtin.graph_workflow import GraphWorkflow  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import GraphWorkflow: {e}")

try:
    from flow_sdk.builtin.graph_workflow_run import GraphWorkflowRun  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import GraphWorkflowRun: {e}")

try:
    from flow_sdk.builtin.message_attachment import MessageAttachment  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import MessageAttachment: {e}")

try:
    from flow_sdk.builtin.message_suggest import MessageSuggest  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import MessageSuggest: {e}")

try:
    from flow_sdk.builtin.user_note import UserNote  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import UserNote: {e}")

try:
    from flow_sdk.builtin.agent_trace import AgentTrace  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import AgentTrace: {e}")

try:
    from flow_sdk.builtin.usage_report import UsageReport  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import UsageReport: {e}")

try:
    from flow_sdk.builtin.asset_cleanup_report import AssetCleanupReport  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import AssetCleanupReport: {e}")

try:
    from flow_sdk.builtin.workflow_run import WorkflowRun  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import WorkflowRun: {e}")

try:
    from flow_sdk.builtin.folder import Folder  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import Folder: {e}")

# These have more complex dependencies - skip for now
# from builtin.page import Page  # noqa: F401
# from builtin.task import Task  # noqa: F401
# from builtin.question import Question  # noqa: F401

try:
    from flow_sdk.builtin.comment import Comment  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import Comment: {e}")

try:
    from flow_sdk.builtin.claude_memory_entities import (  # noqa: F401
        ClaudeMd,
        ClaudeMemory,
        ClaudePlan,
        ClaudeRules,
        Docs,
        Markdown,
    )
except ImportError as e:
    print(f"[WARN] Failed to import claude memory entities: {e}")

try:
    # ClaudeSession (ClaudeTranscript) — must register independently of the
    # indexer registrations import, or a receiver that never ran an index walk
    # can't materialize shared claude_session stubs (get_entity_cls → None).
    from flow_sdk.builtin.claude_session import ClaudeSession  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import ClaudeSession: {e}")

try:
    # DynamicWorkflow — a Claude Code workflow run surfaced as a read-only asset.
    from flow_sdk.builtin.dynamic_workflow import DynamicWorkflow  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import DynamicWorkflow: {e}")

try:
    from flow_sdk.builtin.artifact import Artifact  # noqa: F401
    from flow_sdk.builtin.deployment import Deployment  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import Artifact/Deployment entities: {e}")

try:
    from flow_sdk.builtin.markdown_index import MarkdownIndex  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import MarkdownIndex: {e}")

try:
    from flow_sdk.builtin.file import File  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import File: {e}")

try:
    from flow_sdk.builtin.tab import Tab  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import Tab: {e}")

try:
    from flow_sdk.builtin.inbox_manager import InboxManager  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import InboxManager: {e}")

__all__ = []
