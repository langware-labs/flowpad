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
    from flow_sdk.builtin.workspace import Workspace  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import Workspace: {e}")

try:
    from flow_sdk.builtin.agent import Agent  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import Agent: {e}")

try:
    from flow_sdk.builtin.api_key import ApiKey  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import ApiKey: {e}")

try:
    from flow_sdk.builtin.compute_node import ComputeNode  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import ComputeNode: {e}")

# Flow entity
try:
    from flow_sdk.builtin.process import Flow  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import Flow: {e}")

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
    from flow_sdk.builtin.cron_event import CronEvent  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import CronEvent: {e}")

try:
    from flow_sdk.builtin.workflow import Workflow  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import Workflow: {e}")

try:
    from flow_sdk.builtin.skill import Skill  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import Skill: {e}")

try:
    from flow_sdk.builtin.whiteboard import Whiteboard  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import Whiteboard: {e}")

# These have more complex dependencies - skip for now
# from builtin.page import Page  # noqa: F401
# from builtin.task import Task  # noqa: F401
# from builtin.question import Question  # noqa: F401

try:
    from flow_sdk.builtin.comment import Comment  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import Comment: {e}")

try:
    from flow_sdk.builtin.claude_memory_entities import Markdown, Docs, ClaudeMemory, ClaudeRules, ClaudePlan, ClaudeMd  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import claude memory entities: {e}")

try:
    from flow_sdk.builtin.markdown_index import MarkdownIndex  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import MarkdownIndex: {e}")

try:
    from flow_sdk.builtin.git_repo import GitRepo  # noqa: F401
except ImportError as e:
    print(f"[WARN] Failed to import GitRepo: {e}")

__all__ = []
