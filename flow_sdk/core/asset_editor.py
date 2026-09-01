"""Asset-editor vocabulary — Python side of a cross-language contract.

The `<editor>` segment of an asset-editor dock URL
(``/dock/assets/editor/<editor>/typeid/<type>-<id>``) and the record-type →
editor mapping behind it were owned solely by ``ts_sdk/src/models/asset-editor.ts``
until the backend needed to hand out a deep link of its own (``dock_url`` in
``flow_sdk/core/display_target.py``, reached through ``flow record url``).

This module mirrors only the half the backend consumes: entity type → editor.
The extension → viewer half (`editorForPath`, for raw files with no entity)
stays TypeScript-only until something here needs it — a duplicated row nobody
reads is drift waiting to happen. Adding it back belongs with the VFS-URL
follow-up in docs/display-capabilities.md §9.

The two sides are pinned by
``tests/fixtures/asset_editor_contract.json``, which BOTH
``tests/unit/test_asset_editor_contract.py`` and
``ui/tests/unit/asset-editor-contract.test.ts`` assert against — neither
generates it. That is deliberate: a generated fixture would make one language
authoritative and reduce the other suite to a tautology, whereas an
independently-stated third copy means a Python-only edit here fails the
TypeScript suite too. Change the fixture only with both suites in hand.

Lives beside ``display_target.py`` — its only consumer, and the module that
already owns "what does this address show".
"""

from __future__ import annotations

from flow_sdk._compat import StrEnum
from flow_sdk.schema.types import EntityType


class AssetEditor(StrEnum):
    """Canonical editor names. Values are the URL segment verbatim."""

    CODE = "code"  # raw text editor — any file, no backing entity
    MARKDOWN = "markdown"  # rich markdown editor — entity-backed markdown family
    SUBAGENT = "subagent"
    AGENT = "agent"
    SKILL = "skill"
    TASK = "task"
    WHITEBOARD = "whiteboard"
    DECK_TEMPLATE = "deck_template"
    DECK = "deck"
    SPREADSHEET = "spreadsheet"  # CSV (editable) / XLSX (read-only) grid
    AGENT_TRACE = "agent_trace"
    DYNAMIC_WORKFLOW = "dynamic_workflow"
    USAGE_REPORT = "usage_report"
    ASSET_CLEANUP_REPORT = "asset_cleanup_report"
    JOURNEY = "journey"
    MCP = "mcp"  # an MCP server asset (agentic-assets/mcp/<name>/mcp.json)
    # File-only display viewers — no backing record type, routed by extension
    # on the TS side (like CODE, they never appear in TYPE_TO_EDITOR).
    HTML = "html"
    MCP_APP = "mcp_app"
    IMAGE = "image"
    VIDEO = "video"
    AUDIO = "audio"
    PDF = "pdf"


#: editor → the entity types it edits. Written with ``EntityType`` members
#: rather than bare strings so a typo is an AttributeError here, not a silent
#: miss at lookup time.
EDITOR_TYPES: dict[AssetEditor, list[str]] = {
    AssetEditor.CODE: [],
    AssetEditor.MARKDOWN: [
        EntityType.MARKDOWN,
        EntityType.CLAUDE_MD,
        EntityType.CLAUDE_MEMORY,
        EntityType.CLAUDE_RULES,
        EntityType.COMMAND,
        EntityType.PLAN,
        EntityType.PROMPT,
    ],
    AssetEditor.SUBAGENT: [EntityType.SUBAGENT],
    AssetEditor.AGENT: [EntityType.AGENT],
    AssetEditor.SKILL: [EntityType.SKILL],
    AssetEditor.TASK: [EntityType.TASK],
    AssetEditor.WHITEBOARD: [EntityType.WHITEBOARD],
    AssetEditor.DECK_TEMPLATE: [EntityType.DECK_TEMPLATE],
    AssetEditor.DECK: [EntityType.DECK],
    AssetEditor.SPREADSHEET: [EntityType.SPREADSHEET],
    AssetEditor.AGENT_TRACE: [EntityType.AGENT_TRACE],
    AssetEditor.DYNAMIC_WORKFLOW: [EntityType.DYNAMIC_WORKFLOW],
    AssetEditor.USAGE_REPORT: [EntityType.USAGE_REPORT],
    AssetEditor.ASSET_CLEANUP_REPORT: [EntityType.ASSET_CLEANUP_REPORT],
    AssetEditor.JOURNEY: [EntityType.JOURNEY],
    AssetEditor.MCP: [EntityType.MCP],
    AssetEditor.HTML: [],
    AssetEditor.MCP_APP: [],
    AssetEditor.IMAGE: [],
    AssetEditor.VIDEO: [],
    AssetEditor.AUDIO: [],
    AssetEditor.PDF: [],
}

#: Derived inverse, exactly as the TS side derives it.
TYPE_TO_EDITOR: dict[str, AssetEditor] = {
    str(type_name): editor for editor, types in EDITOR_TYPES.items() for type_name in types
}


def editor_for_type(type_name: str) -> AssetEditor | None:
    """The editor that edits ``type_name``, or None when it has no asset editor.

    None is a real answer, not a failure: a shell, a project, a conversation is
    not a document. Callers must say so rather than inventing a segment — the
    TS ``assetEditorPointer`` returns null for the same reason.
    """
    return TYPE_TO_EDITOR.get(type_name)
