import { DOCK_KEYWORD, DEV_KEYWORD, Layout, ViewType } from '@sdk';

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
  const dockIndex = fullPath.indexOf(`/${DOCK_KEYWORD}/`);
  const devIndex = fullPath.indexOf(`/${DEV_KEYWORD}/`);

  if (dockIndex === -1 && devIndex === -1) return null;

  const isDock = dockIndex !== -1 && (devIndex === -1 || dockIndex < devIndex);
  const layoutIndex = isDock ? dockIndex : devIndex;
  const layout = isDock ? Layout.DOCK : Layout.DEV;
  const keywordLength = isDock ? DOCK_KEYWORD.length : DEV_KEYWORD.length;

  // Parse base path (before dock/dev)
  const basePath = fullPath.substring(0, layoutIndex);
  const { agentId, processId } = parseBasePath(basePath);

  // Parse dock portion (after dock/dev keyword)
  const dockPortion = fullPath.substring(layoutIndex + keywordLength + 2); // +2 for slashes
  const [viewType, ...pointerParts] = dockPortion.split('/');
  const pointer = pointerParts.length > 0 ? pointerParts.join('/') : undefined;

  return { agentId, processId, viewType: viewType || undefined, pointer, layout };
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
  const dockIndex = currentPath.indexOf(`/${DOCK_KEYWORD}/`);
  const devIndex = currentPath.indexOf(`/${DEV_KEYWORD}/`);

  // Find the first occurrence of either layout keyword
  let layoutIndex = -1;
  if (dockIndex > -1 && devIndex > -1) {
    layoutIndex = Math.min(dockIndex, devIndex);
  } else if (dockIndex > -1) {
    layoutIndex = dockIndex;
  } else if (devIndex > -1) {
    layoutIndex = devIndex;
  }

  if (layoutIndex > -1) {
    return currentPath.substring(0, layoutIndex);
  }

  // No dock/dev found, return path without trailing slash
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
  // Get base URL (everything before dock/dev)
  const base = stripDockPortion(currentUrl);

  // Choose layout keyword based on layout parameter
  const layoutKeyword = layout === Layout.DEV ? DEV_KEYWORD : DOCK_KEYWORD;

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
