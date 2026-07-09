import { RecordType } from '../resource_management/fs_records/record-types';

/**
 * Canonical asset-editor vocabulary — the single source of truth for the
 * `<editor>` URL segment and the record-type → editor mapping. Lives in the SDK
 * (the lower layer that owns `RecordType` and the entity pointer getters); the
 * UI re-exports these from `ui/src/navigation/asset-doc-types.ts`.
 */
export enum AssetEditor {
  CODE = 'code', // raw text editor — any file, no backing entity
  MARKDOWN = 'markdown', // rich markdown editor — entity-backed markdown family
  AGENT = 'agent',
  SKILL = 'skill',
  WORKFLOW = 'workflow',
  WHITEBOARD = 'whiteboard',
  AGENT_TRACE = 'agent_trace',
  DYNAMIC_WORKFLOW = 'dynamic_workflow',
  USAGE_REPORT = 'usage_report',
}

/** editor → record types it edits. `code` is file-only (no record type). */
export const EDITOR_TYPES: Record<AssetEditor, RecordType[]> = {
  [AssetEditor.CODE]: [],
  [AssetEditor.MARKDOWN]: [
    RecordType.MARKDOWN,
    RecordType.CLAUDE_MD,
    RecordType.CLAUDE_MEMORY,
    RecordType.CLAUDE_RULES,
    RecordType.COMMAND,
    RecordType.PLAN,
    RecordType.PROMPT, // library prompt — md + frontmatter (docs/prompt-library.md)
  ],
  [AssetEditor.AGENT]: [RecordType.AGENT],
  [AssetEditor.SKILL]: [RecordType.SKILL],
  [AssetEditor.WORKFLOW]: [RecordType.WORKFLOW],
  [AssetEditor.WHITEBOARD]: [RecordType.WHITEBOARD],
  [AssetEditor.AGENT_TRACE]: [RecordType.AGENT_TRACE],
  [AssetEditor.DYNAMIC_WORKFLOW]: [RecordType.DYNAMIC_WORKFLOW],
  [AssetEditor.USAGE_REPORT]: [RecordType.USAGE_REPORT],
};

/** Derived inverse: record type → the editor that edits it. */
export const TYPE_TO_EDITOR: Record<string, AssetEditor> = Object.fromEntries(
  Object.entries(EDITOR_TYPES).flatMap(([editor, types]) =>
    types.map((t) => [t as string, editor as AssetEditor]),
  ),
);

/** The editor that edits `type`, or undefined if the type has no asset editor. */
export function editorForType(type: string): AssetEditor | undefined {
  return TYPE_TO_EDITOR[type];
}

export function isAssetEditor(v: string): v is AssetEditor {
  return (Object.values(AssetEditor) as string[]).includes(v);
}

/**
 * Editor for a RAW file path (no entity): the markdown family by extension,
 * everything else the plain code editor. The single home of the
 * "which extensions are markdown" rule — navigate_vfs and the vibe display
 * both route through this.
 */
export function editorForPath(path: string): AssetEditor {
  const ext = path.split('.').pop()?.toLowerCase();
  return ext === 'md' || ext === 'markdown' ? AssetEditor.MARKDOWN : AssetEditor.CODE;
}
