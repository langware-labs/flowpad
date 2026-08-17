import { RecordType } from '../resource_management/fs_records/record-types';
import { IMAGE_EXTENSIONS } from '../utils/utils';

/**
 * Canonical asset-editor vocabulary — the single source of truth for the
 * `<editor>` URL segment and the record-type → editor mapping. Lives in the SDK
 * (the lower layer that owns `RecordType` and the entity pointer getters); the
 * UI re-exports these from `ui/src/navigation/asset-doc-types.ts`.
 */
export enum AssetEditor {
  CODE = 'code', // raw text editor — any file, no backing entity
  MARKDOWN = 'markdown', // rich markdown editor — entity-backed markdown family
  SUBAGENT = 'subagent',
  AGENT = 'agent',
  SKILL = 'skill',
  TASK = 'task',
  WHITEBOARD = 'whiteboard',
  DECK_TEMPLATE = 'deck_template',
  DECK = 'deck',
  SPREADSHEET = 'spreadsheet', // CSV (editable) / XLSX (read-only) grid — entity-backed
  AGENT_TRACE = 'agent_trace',
  DYNAMIC_WORKFLOW = 'dynamic_workflow',
  USAGE_REPORT = 'usage_report',
  ASSET_CLEANUP_REPORT = 'asset_cleanup_report',
  JOURNEY = 'journey', // guided onboarding — overview + Start, opens the journey tray
  // File-only display viewers — no backing record type, routed by extension
  // via `editorForPath` (like CODE, they never appear in TYPE_TO_EDITOR).
  HTML = 'html', // sandboxed live preview of a self-contained .html deliverable
  MCP_APP = 'mcp_app', // MCP App (.mcp.html) — sandbox + agent bridge
  IMAGE = 'image',
  VIDEO = 'video',
  AUDIO = 'audio',
  PDF = 'pdf', // native browser render of a .pdf via <iframe>/<embed>
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
  [AssetEditor.SUBAGENT]: [RecordType.SUBAGENT],
  [AssetEditor.AGENT]: [RecordType.AGENT],
  [AssetEditor.SKILL]: [RecordType.SKILL],
  [AssetEditor.TASK]: [RecordType.TASK],
  [AssetEditor.WHITEBOARD]: [RecordType.WHITEBOARD],
  [AssetEditor.DECK_TEMPLATE]: [RecordType.DECK_TEMPLATE],
  [AssetEditor.DECK]: [RecordType.DECK],
  [AssetEditor.SPREADSHEET]: [RecordType.SPREADSHEET],
  [AssetEditor.AGENT_TRACE]: [RecordType.AGENT_TRACE],
  [AssetEditor.DYNAMIC_WORKFLOW]: [RecordType.DYNAMIC_WORKFLOW],
  [AssetEditor.USAGE_REPORT]: [RecordType.USAGE_REPORT],
  [AssetEditor.ASSET_CLEANUP_REPORT]: [RecordType.ASSET_CLEANUP_REPORT],
  [AssetEditor.JOURNEY]: [RecordType.JOURNEY],
  [AssetEditor.HTML]: [],
  [AssetEditor.MCP_APP]: [],
  [AssetEditor.IMAGE]: [],
  [AssetEditor.VIDEO]: [],
  [AssetEditor.AUDIO]: [],
  [AssetEditor.PDF]: [],
};

/** True for editors that render raw files and have no backing record type. */
export function isFileOnlyEditor(editor: AssetEditor): boolean {
  return EDITOR_TYPES[editor].length === 0;
}

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

/** Extension → file-only viewer/editor. Single source: every "open/show a raw
 * file" surface (openFile, explorer, chat attachments, vibe display) routes
 * through `editorForPath`, so adding a viewer means adding a row here. */
const EXT_TO_EDITOR: Record<string, AssetEditor> = {
  md: AssetEditor.MARKDOWN,
  markdown: AssetEditor.MARKDOWN,
  // Tabular files — same dual routing as markdown (entity-backed AND
  // extension-routed). XLSX opens read-only; CSV is editable.
  csv: AssetEditor.SPREADSHEET,
  xlsx: AssetEditor.SPREADSHEET,
  html: AssetEditor.HTML,
  htm: AssetEditor.HTML,
  ...Object.fromEntries([...IMAGE_EXTENSIONS].map((ext) => [ext, AssetEditor.IMAGE])),
  mp4: AssetEditor.VIDEO,
  webm: AssetEditor.VIDEO,
  mov: AssetEditor.VIDEO,
  mp3: AssetEditor.AUDIO,
  wav: AssetEditor.AUDIO,
  m4a: AssetEditor.AUDIO,
  ogg: AssetEditor.AUDIO,
  pdf: AssetEditor.PDF,
};

/** MCP-app suffix rule — `.mcp.html` needs a suffix check because its last-dot
 * extension is plain `html`. The UI's `isMcpAppPath` delegates here. */
const MCP_APP_PATH_RE = /\.mcp\.html?$/i;

/**
 * Editor for a RAW file path (no entity). Unknown extensions fall back to the
 * plain code editor.
 */
export function editorForPath(path: string): AssetEditor {
  if (MCP_APP_PATH_RE.test(path)) return AssetEditor.MCP_APP;
  const ext = path.split('.').pop()?.toLowerCase();
  return (ext && EXT_TO_EDITOR[ext]) || AssetEditor.CODE;
}
