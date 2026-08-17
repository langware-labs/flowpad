import { DOCK_KEYWORD, DEV_KEYWORD, WIN_KEYWORD, Layout, ViewType, PageId, isValidPage } from '@sdk';

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

/**
 * THE statement that the desk home is spelled `/`.
 *
 * The app root is an ordinary location — a `DockPointer` for the desk `HOME`
 * view with no pointer — it just has a shorter URL than the dock grammar would
 * give it. Both directions consult this one predicate, so `/` and
 * `DockPointer.root()` can never disagree about which is which.
 *
 * Deliberately narrow. Three things are NOT the root and keep their dock URLs:
 *  - `page=hub` — `/dock/hub/home` is the hub's own home, a different surface;
 *  - HOME with a pointer — `/dock/home/<x>`, still addressed the normal way;
 *  - a non-DOCK layout — collapsing `/win/home` to `/` would break a focus
 *    window out of its own chrome.
 */
export function isRootAddress(
  viewType: ViewType | undefined,
  pointer: string | undefined,
  layout: Layout,
  page: PageId,
): boolean {
  return viewType === ViewType.HOME && !pointer && layout === Layout.DOCK && page === PageId.DESK;
}

/** The app root's path. The one place the literal lives. */
export const ROOT_PATH = '/';

/** The parse of a layout-less path: the root, under whatever base path it carries. */
export function rootDockAddress(fullPath: string): ParsedDockUrl {
  return {
    ...parseBasePath(fullPath),
    page: PageId.DESK,
    viewType: ViewType.HOME,
    pointer: undefined,
    layout: Layout.DOCK,
  };
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
export function buildShellRedirectUrl(
  currentPath: string,
  pointer?: string,
  options?: Record<string, string>,
): string {
  return buildDockUrl(currentPath, ViewType.SHELL, pointer, options, detectLayout(currentPath));
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
  page: PageId;
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
 * => { page: "desk", viewType: "skills", layout: "dock" }
 *
 * parseDockUrl("/dock/hub/organization")
 * => { page: "hub", viewType: "organization", layout: "dock" }
 */
export function parseDockUrl(fullPath: string): ParsedDockUrl | null {
  const token = findLayoutToken(fullPath);
  if (!token) return null;

  // Parse base path (before the layout keyword)
  const basePath = fullPath.substring(0, token.index);
  const { agentId, processId } = parseBasePath(basePath);

  // Parse dock portion (after the layout keyword)
  const dockPortion = fullPath.substring(token.index + token.keyword.length + 2); // +2 for slashes
  const segments = dockPortion.split('/');

  // The segment right after the layout keyword is the page IFF it is a known page
  // id; otherwise it is the viewType and page defaults to `desk` (back-compat —
  // every existing `/dock/<viewType>/…` URL is unaffected).
  const hasPage = isValidPage(segments[0]);
  const page = hasPage ? (segments[0] as PageId) : PageId.DESK;

  const [viewType, ...pointerParts] = hasPage ? segments.slice(1) : segments;
  const pointer = pointerParts.length > 0 ? pointerParts.join('/') : undefined;

  return { agentId, processId, page, viewType: viewType || undefined, pointer, layout: token.layout };
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
 * Rewrite a `/dev/…` URL into its `/dock/…` twin.
 *
 * `dev` and `dock` are interchangeable layout keywords to every parser here, so
 * people arrive on `/dev/…` from copy/paste, stale links and hand-typed URLs —
 * and without this the root catch-all swallows them into NotFound. Lives beside
 * the keyword table it depends on rather than in the router, where it was a
 * regex that would silently stop matching if a keyword were ever renamed.
 */
export function devToDockPath(pathname: string): string {
  return `/${DOCK_KEYWORD}/${pathname.replace(new RegExp(`^/${DEV_KEYWORD}/?`), '')}`;
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
 * @param page - SPA-surface, defaults to DESK. Emitted as a `/<page>` segment
 *   ONLY when non-desk, so existing `/dock/<viewType>` URLs stay byte-identical.
 */
export function buildDockUrl(
  currentUrl: string,
  viewType: ViewType,
  pointer?: string,
  queryParams?: Record<string, string | undefined>,
  layout: Layout = Layout.DOCK,
  page: PageId = PageId.DESK,
): string {
  // Get base URL (everything before the layout keyword)
  const base = stripDockPortion(currentUrl);

  // Choose layout keyword based on layout parameter
  const layoutKeyword = keywordForLayout(layout);

  // Page segment sits between the layout keyword and the viewType; `desk` is the
  // default and is never emitted (bare `/dock/<viewType>` == desk).
  const pageSegment = page === PageId.DESK ? '' : `/${page}`;

  // Build layout URL with or without pointer
  let layoutBase = `${base}/${layoutKeyword}${pageSegment}/${viewType}`;
  if (pointer && pointer.length > 0) {
    const cleanPointer = pointer.startsWith('/') ? pointer.slice(1) : pointer;
    // Encode each path segment individually to preserve slashes
    const encodedPointer = cleanPointer
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    layoutBase += `/${encodedPointer}`;
  }

  // The root is the base path itself — `/` at the app root, or the agent/flow
  // prefix when one is being preserved. `base` is '' for a bare root, so it is
  // normalized here rather than at each call site.
  const urlBase = isRootAddress(viewType, pointer, layout, page)
    ? base || '/'
    : typeof viewType === 'undefined'
      ? base
      : layoutBase;

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
