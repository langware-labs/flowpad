import { DOCK_KEYWORD, DEV_KEYWORD, WIN_KEYWORD, Layout, ViewType } from '@sdk';

/**
 * The single keyword→Layout table the parse/strip/build helpers below share.
 * Adding a layout means adding a row here — nothing else in this file
 * special-cases a keyword.
 */
const LAYOUT_KEYWORDS: ReadonlyArray<{ keyword: string; layout: Layout }> = [
  { keyword: DOCK_KEYWORD, layout: Layout.DOCK },
  { keyword: DEV_KEYWORD, layout: Layout.DEV },
  { keyword: WIN_KEYWORD, layout: Layout.WIN },
];

function keywordForLayout(layout: Layout): string {
  return LAYOUT_KEYWORDS.find((row) => row.layout === layout)?.keyword ?? DOCK_KEYWORD;
}

interface LayoutToken {
  layout: Layout;
  keyword: string;
  index: number;
}

/**
 * Find the first layout keyword (`/dock/`, `/dev/`, `/win/`) in a path.
 * First occurrence wins — matching the historical dock-vs-dev tie-break.
 */
function findLayoutToken(path: string): LayoutToken | null {
  let best: LayoutToken | null = null;
  for (const { keyword, layout } of LAYOUT_KEYWORDS) {
    const index = path.indexOf(`/${keyword}/`);
    if (index === -1) continue;
    if (!best || index < best.index) best = { layout, keyword, index };
  }
  return best;
}

/**
 * Derive the Layout from a URL path. Paths without a layout keyword default
 * to DOCK (the layout `buildDockUrl` also defaults to).
 */
export function detectLayout(path: string): Layout {
  return findLayoutToken(path)?.layout ?? Layout.DOCK;
}

/**
 * Morph rule (docs/tab-management.md Part 3 §7): navigation initiated from
 * inside a `win/` focus window preserves the WIN layout so internal
 * navigation morphs the window and stays chrome-less. Outside a win window
 * the requested layout passes through unchanged.
 */
export function preserveWindowLayout(currentPath: string, layout: Layout): Layout {
  return detectLayout(currentPath) === Layout.WIN ? Layout.WIN : layout;
}

/**
 * Build a /shell redirect URL that preserves the current URL's layout —
 * loader redirects inside `win/` must not dump the focus window back into
 * full-app chrome (Part 3 §7). Used by the shell route loader's fallback /
 * ownership redirects.
 */
export function buildShellRedirectUrl(currentPath: string, pointer?: string): string {
  return buildDockUrl(currentPath, ViewType.SHELL, pointer, undefined, detectLayout(currentPath));
}

/**
 * Parsed entities from the base path (before dock/dev keyword)
 */
export interface ParsedBasePath {
  agentId?: string;
  processId?: string;
}

/**
 * Full parsed dock URL including base path entities and dock portion
 */
export interface ParsedDockUrl extends ParsedBasePath {
  viewType?: string;
  pointer?: string;
  layout: Layout;
}

/**
 * Parse entity IDs from the base path (before dock/dev keyword)
 * Extracts agentId and processId from URL patterns like /agent/:agentId/flow/:processId
 *
 * @example
 * parseBasePath("/agent/abc/flow/xyz") => { agentId: "abc", processId: "xyz" }
 * parseBasePath("/agent/abc") => { agentId: "abc" }
 * parseBasePath("") => {}
 */
export function parseBasePath(basePath: string): ParsedBasePath {
  const agentMatch = basePath.match(/\/agent\/([^/]+)/);
  const flowMatch = basePath.match(/\/flow\/([^/]+)/);
  return {
    agentId: agentMatch?.[1],
    processId: flowMatch?.[1],
  };
}

/**
 * Parse a full URL containing dock/dev keyword into its components
 * Returns null if no dock/dev keyword found
 *
 * @example
 * parseDockUrl("/agent/abc/flow/xyz/dock/editor/file.ts")
 * => { agentId: "abc", processId: "xyz", viewType: "editor", pointer: "file.ts", layout: "dock" }
 *
 * parseDockUrl("/dock/skills")
 * => { viewType: "skills", layout: "dock" }
 */
export function parseDockUrl(fullPath: string): ParsedDockUrl | null {
  const token = findLayoutToken(fullPath);
  if (!token) return null;

  // Parse base path (before the layout keyword)
  const basePath = fullPath.substring(0, token.index);
  const { agentId, processId } = parseBasePath(basePath);

  // Parse dock portion (after the layout keyword)
  const dockPortion = fullPath.substring(token.index + token.keyword.length + 2); // +2 for slashes
  const [viewType, ...pointerParts] = dockPortion.split('/');
  const pointer = pointerParts.length > 0 ? pointerParts.join('/') : undefined;

  return { agentId, processId, viewType: viewType || undefined, pointer, layout: token.layout };
}

/**
 * Strip the dock/dev portion from a URL path
 * Returns the base URL before the layout keyword
 *
 * @example
 * stripDockPortion("/agent/abc/flow/xyz/dock/editor/file.ts") => "/agent/abc/flow/xyz"
 * stripDockPortion("/agent/abc/dock/skills") => "/agent/abc"
 * stripDockPortion("/agent/abc/flow/xyz") => "/agent/abc/flow/xyz"
 */
export function stripDockPortion(currentPath: string): string {
  // Find the first occurrence of any layout keyword (dock/dev/win)
  const token = findLayoutToken(currentPath);
  if (token) {
    return currentPath.substring(0, token.index);
  }

  // No layout keyword found, return path without trailing slash
  return currentPath.replace(/\/$/, '');
}

/**
 * Build a layout URL by replacing or appending the dock portion
 * Takes the current URL and replaces everything after dock/dev keyword
 *
 * @param currentUrl - Current URL path (e.g., "/agent/abc/flow/xyz/dock/editor/file.ts")
 * @param viewType - The view type to navigate to
 * @param pointer - Optional pointer (file path, skill name, etc.)
 * @param queryParams - Optional query parameters
 * @param layout - Layout type (dock or dev), defaults to DOCK
 */
export function buildDockUrl(
  currentUrl: string,
  viewType: ViewType,
  pointer?: string,
  queryParams?: Record<string, string | undefined>,
  layout: Layout = Layout.DOCK,
): string {
  // Get base URL (everything before the layout keyword)
  const base = stripDockPortion(currentUrl);

  // Choose layout keyword based on layout parameter
  const layoutKeyword = keywordForLayout(layout);

  // Build layout URL with or without pointer
  let layoutBase = `${base}/${layoutKeyword}/${viewType}`;
  if (pointer && pointer.length > 0) {
    const cleanPointer = pointer.startsWith('/') ? pointer.slice(1) : pointer;
    // Encode each path segment individually to preserve slashes
    const encodedPointer = cleanPointer
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    layoutBase += `/${encodedPointer}`;
  }

  // If viewType is undefined, use base, otherwise use layoutBase
  const urlBase = typeof viewType === 'undefined' ? base : layoutBase;

  // Filter undefined values and build query string
  if (!queryParams) return urlBase;

  const params = new URLSearchParams();
  Object.entries(queryParams).forEach(([key, value]) => {
    if (value !== undefined) {
      params.set(key, value);
    }
  });

  const query = params.toString();
  return query ? `${urlBase}?${query}` : urlBase;
}

/**
 * Parse query parameters from URLSearchParams to options object
 */
export function parseQueryParams(searchParams: URLSearchParams): Record<string, string> {
  const options: Record<string, string> = {};
  searchParams.forEach((value, key) => {
    options[key] = value;
  });
  return options;
}
