import { isFolderShape, type TypeShape } from '../FlowSync/schema';
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
  MCP = 'mcp', // an MCP server asset (agentic-assets/mcp/<name>/mcp.json)
  // File-only display viewers — no backing record type, routed by extension
  // via `editorForPath` (like CODE, they never appear in TYPE_TO_EDITOR).
  HTML = 'html', // sandboxed live preview of a self-contained .html deliverable
  MCP_APP = 'mcp_app', // MCP App (.mcp.html) — sandbox + agent bridge
  IMAGE = 'image',
  VIDEO = 'video',
  AUDIO = 'audio',
  PDF = 'pdf', // native browser render of a .pdf via <iframe>/<embed>
}

/**
 * The slice of the bootstrap `TypeInfo` this module reads. The store BINDS its
 * registry into this module at bootstrap; only the SHAPE is shared, from the
 * one declaration of it (`FlowSync/schema`), so a backend shape change lands in
 * one place instead of two that silently drift.
 */
export interface EditorTypeInfo {
  type_name: string;
  /** Backend-declared editor for the type (`'markdown'`, `'skill'`, …). */
  editor?: string | null;
  /** Backend-declared on-disk shape. */
  shape?: TypeShape | null;
}

/** Read-side of the registry: a type lookup and the full list. */
export interface EditorTypeRegistry {
  get(type: string): EditorTypeInfo | undefined;
  all(): EditorTypeInfo[];
}

let registry: EditorTypeRegistry | null = null;

/**
 * Bind the frontend SchemaRegistry (bootstrap `types`) as the authority for the
 * type → editor mapping and the per-type file extensions. Called by the store
 * once `loadTypes` has populated it. Until then — and on the hub, whose
 * bootstrap ships no `types` — every lookup falls back to the static tables.
 */
export function bindAssetEditorRegistry(r: EditorTypeRegistry | null): void {
  registry = r;
}

/** Registry entry for `type`, or undefined when unbound / unknown. */
function registryEntry(type: string): EditorTypeInfo | undefined {
  if (!registry || typeof type !== 'string') return undefined;
  try {
    return registry.get(type);
  } catch {
    return undefined;
  }
}

function registryAll(): EditorTypeInfo[] {
  if (!registry) return [];
  try {
    return registry.all();
  } catch {
    return [];
  }
}

/** editor → record types it edits. `code` is file-only (no record type).
 *  STATIC fallback table — the registry (`TypeInfo.editor`) is the authority
 *  whenever it is bound; see `editorForType`. */
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
  [AssetEditor.MCP]: [RecordType.MCP],
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

/** Derived inverse of the STATIC table: record type → the editor that edits it. */
export const TYPE_TO_EDITOR: Record<string, AssetEditor> = Object.fromEntries(
  Object.entries(EDITOR_TYPES).flatMap(([editor, types]) =>
    types.map((t) => [t as string, editor as AssetEditor]),
  ),
);

/**
 * The editor that edits `type`, or undefined if the type has no asset editor.
 *
 * The bound registry (`TypeInfo.editor`) answers first; the static table only
 * answers when the registry has no entry for the type — the hub bootstrap
 * ships no `types`, and a unit test may run with nothing bound.
 */
export function editorForType(type: string): AssetEditor | undefined {
  const declared = registryEntry(type)?.editor;
  if (declared && isAssetEditor(declared)) return declared;
  return TYPE_TO_EDITOR[type];
}

/**
 * The record type the registry declares for `editor` — the inverse of
 * `editorForType` read from the SAME authority, for a caller that only has
 * the editor segment of a pointer. Undefined when the registry is unbound or
 * no type declares that editor; callers must not guess in that case.
 */
export function primaryTypeForEditor(editor: string): string | undefined {
  return registryAll().find((t) => t.editor === editor)?.type_name;
}

export function isAssetEditor(v: string): v is AssetEditor {
  return (Object.values(AssetEditor) as string[]).includes(v);
}

/** `.md` → `md`; tolerant of a bare `md`. */
function bareExt(ext: string): string {
  return ext.replace(/^\./, '').toLowerCase();
}

/**
 * File extensions (without the dot) the registry declares for `type` — the
 * file-shaped `shape.ext` plus its `also` list. Empty when the registry is
 * unbound, the type is unknown, or the type is folder-shaped.
 */
export function registryExtensionsForType(type: string): string[] {
  const shape = registryEntry(type)?.shape;
  if (!shape || shape.kind !== 'file' || !shape.ext) return [];
  return [shape.ext, ...(shape.also ?? [])].map(bareExt).filter(Boolean);
}

/** Static markdown extensions — the fallback when the registry is unbound. */
const STATIC_MARKDOWN_EXTENSIONS = ['md', 'markdown'];
/** Static spreadsheet extensions — the fallback when the registry is unbound. */
const STATIC_SPREADSHEET_EXTENSIONS = ['csv', 'xlsx'];

/**
 * Extensions the markdown editor opens: the registry's `markdown` shape when
 * bound, else the static pair. Every "is this a markdown document?" predicate
 * derives from here so the set cannot drift between surfaces.
 */
export function markdownExtensions(): string[] {
  const fromRegistry = registryExtensionsForType(RecordType.MARKDOWN);
  return fromRegistry.length ? fromRegistry : STATIC_MARKDOWN_EXTENSIONS;
}

/** Extensions the spreadsheet editor opens — same derivation as markdown. */
export function spreadsheetExtensions(): string[] {
  const fromRegistry = registryExtensionsForType(RecordType.SPREADSHEET);
  return fromRegistry.length ? fromRegistry : STATIC_SPREADSHEET_EXTENSIONS;
}

/** Extension → file-only viewer/editor for the rows that never come from the
 * registry. Single source: every "open/show a raw file" surface (openFile,
 * explorer, chat attachments, vibe display) routes through `editorForPath`, so
 * adding a viewer means adding a row here. */
const STATIC_EXT_TO_EDITOR: Record<string, AssetEditor> = {
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

/**
 * The full extension → editor table. Computed per call (cheap: two registry
 * reads) because the markdown / spreadsheet rows come from the registry, which
 * is bound AFTER module init.
 */
export function extToEditor(): Record<string, AssetEditor> {
  return {
    ...Object.fromEntries(markdownExtensions().map((ext) => [ext, AssetEditor.MARKDOWN])),
    // Tabular files — same dual routing as markdown (entity-backed AND
    // extension-routed). XLSX opens read-only; CSV is editable.
    ...Object.fromEntries(spreadsheetExtensions().map((ext) => [ext, AssetEditor.SPREADSHEET])),
    ...STATIC_EXT_TO_EDITOR,
  };
}

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
  return (ext && extToEditor()[ext]) || AssetEditor.CODE;
}

/**
 * Fixed inner main file of a folder-shaped type (`SKILL.md` for `skill`) as the
 * registry declares it; `fallback` when the registry is unbound / silent.
 */
export function mainFileForType(type: string, fallback: string | null = null): string | null {
  const shape = registryEntry(type)?.shape;
  if (isFolderShape(shape) && shape.main) return shape.main;
  return fallback;
}
