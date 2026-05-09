"""Canonical wiring for the production FSIndexer.

Consolidates every registration (previously duplicated in test harnesses) into
one place. The HTTP handlers, search reindex, and the parity tests all pull
from here via ``get_shared_indexer()``.
"""

from __future__ import annotations

from flow_sdk.fs_store.indexer.index_function import FSIndexer
from flow_sdk.fs_store.indexer.roots import default_roots
from flow_sdk.fs_store.record_types import RecordType


# Terminal record types the indexer writes via Record.from_fsref.
# Used by rebuild mode in the index handler to know what to clear.
INDEXABLE_TYPES: list[RecordType] = [
    RecordType.CLAUDE_SESSION,
    RecordType.PROJECT,
    RecordType.CODEX_SESSION,
    RecordType.CODEX_PROJECT,
    RecordType.PLAN,
    RecordType.CLAUDE_MD,
    RecordType.CLAUDE_RULES,
    RecordType.SPEC,
    RecordType.SKILL,
    RecordType.AGENT,
    RecordType.WORKFLOW,
    RecordType.COMMAND,
    RecordType.CLAUDE_MEMORY,
    RecordType.MARKDOWN,
    RecordType.CLAUDE_HOOK,
    RecordType.TASK,
]


def build_default_indexer() -> FSIndexer:
    """Construct an FSIndexer with the canonical root set + all functions registered."""
    # Import locally to keep this module import-light at package-init time.
    from flow_sdk.fs_store.indexer.functions.claude_projects import claude_projects_fn
    from flow_sdk.fs_store.indexer.functions.claude_sessions import claude_sessions_fn
    from flow_sdk.fs_store.indexer.functions.codex_projects import codex_projects_fn
    from flow_sdk.fs_store.indexer.functions.codex_sessions import codex_sessions_fn
    from flow_sdk.fs_store.indexer.functions.real_project_cwd import real_project_cwd_fn
    from flow_sdk.fs_store.indexer.functions.claude_plan import claude_plan_fn
    from flow_sdk.fs_store.indexer.functions.claude_md import (
        claude_md_in_claude_subdir_fn, claude_md_in_project_root_fn,
    )
    from flow_sdk.fs_store.indexer.functions.claude_rules import claude_rules_fn
    from flow_sdk.fs_store.indexer.functions.spec import spec_project_fn
    from flow_sdk.fs_store.indexer.functions.skill import skill_fn
    from flow_sdk.fs_store.indexer.functions.agent import agent_fn
    from flow_sdk.fs_store.indexer.functions.workflow import (
        workflow_fn, workflow_frontmatter_fn,
    )
    from flow_sdk.fs_store.indexer.functions.claude_command import command_fn
    from flow_sdk.fs_store.indexer.functions.claude_memory import claude_memory_fn
    from flow_sdk.fs_store.indexer.functions.markdown import (
        markdown_flat_fn, markdown_in_folder_fn,
    )
    from flow_sdk.fs_store.indexer.functions.project_folder_walker import (
        project_folder_walker_fn,
    )
    from flow_sdk.fs_store.indexer.functions.task import task_fn
    from flow_sdk.fs_store.indexer.functions.claude_hook import (
        claude_hook_fn, claude_hook_extras_fn,
    )

    idx = FSIndexer(
        roots=default_roots(),
    )

    # USER_HOME_FOLDER expanders
    idx.add_function(RecordType.USER_HOME_FOLDER, claude_projects_fn)
    idx.add_function(RecordType.USER_HOME_FOLDER, real_project_cwd_fn)
    idx.add_function(RecordType.USER_HOME_FOLDER, claude_plan_fn)
    idx.add_function(RecordType.USER_HOME_FOLDER, claude_md_in_claude_subdir_fn)
    idx.add_function(RecordType.USER_HOME_FOLDER, claude_rules_fn)
    idx.add_function(RecordType.USER_HOME_FOLDER, skill_fn)
    idx.add_function(RecordType.USER_HOME_FOLDER, agent_fn)
    idx.add_function(RecordType.USER_HOME_FOLDER, workflow_fn)
    idx.add_function(RecordType.USER_HOME_FOLDER, command_fn)
    idx.add_function(RecordType.USER_HOME_FOLDER, markdown_flat_fn)
    idx.add_function(RecordType.USER_HOME_FOLDER, claude_hook_fn)
    idx.add_function(RecordType.USER_HOME_FOLDER, claude_hook_extras_fn)
    idx.add_function(RecordType.USER_HOME_FOLDER, codex_projects_fn)
    idx.add_function(RecordType.USER_HOME_FOLDER, codex_sessions_fn)

    # PROJECT (encoded ~/.claude/projects/<dir>) expanders
    idx.add_function(RecordType.PROJECT, claude_sessions_fn)
    idx.add_function(RecordType.PROJECT, claude_memory_fn)

    # REAL_PROJECT_CWD (decoded cwd) expanders
    idx.add_function(RecordType.REAL_PROJECT_CWD, claude_plan_fn)
    idx.add_function(RecordType.REAL_PROJECT_CWD, claude_md_in_project_root_fn)
    idx.add_function(RecordType.REAL_PROJECT_CWD, claude_rules_fn)
    idx.add_function(RecordType.REAL_PROJECT_CWD, spec_project_fn)
    idx.add_function(RecordType.REAL_PROJECT_CWD, skill_fn)
    idx.add_function(RecordType.REAL_PROJECT_CWD, agent_fn)
    idx.add_function(RecordType.REAL_PROJECT_CWD, workflow_fn)
    idx.add_function(RecordType.REAL_PROJECT_CWD, project_folder_walker_fn)
    idx.add_function(RecordType.REAL_PROJECT_CWD, task_fn)
    idx.add_function(RecordType.REAL_PROJECT_CWD, claude_hook_fn)

    # SYSTEM_ROOT (flowpad_assistant) expanders
    idx.add_function(RecordType.SYSTEM_ROOT, skill_fn)
    idx.add_function(RecordType.SYSTEM_ROOT, agent_fn)
    idx.add_function(RecordType.SYSTEM_ROOT, project_folder_walker_fn)

    # CWD_ROOT expanders
    idx.add_function(RecordType.CWD_ROOT, claude_plan_fn)
    idx.add_function(RecordType.CWD_ROOT, claude_rules_fn)
    idx.add_function(RecordType.CWD_ROOT, skill_fn)
    idx.add_function(RecordType.CWD_ROOT, agent_fn)
    idx.add_function(RecordType.CWD_ROOT, workflow_fn)
    idx.add_function(RecordType.CWD_ROOT, command_fn)
    idx.add_function(RecordType.CWD_ROOT, project_folder_walker_fn)

    # FOLDER (transient scaffold emitted by project_folder_walker_fn) expanders
    idx.add_function(RecordType.FOLDER, markdown_in_folder_fn)
    idx.add_function(RecordType.FOLDER, workflow_frontmatter_fn)
    idx.add_function(RecordType.CWD_ROOT, claude_hook_fn)

    return idx


_shared: FSIndexer | None = None


def get_shared_indexer() -> FSIndexer:
    """Return the process-wide indexer, lazily constructed on first call."""
    global _shared
    if _shared is None:
        _shared = build_default_indexer()
    return _shared


def reset_shared_indexer() -> None:
    """Clear the cached instance — for tests that need a fresh indexer."""
    global _shared
    _shared = None
