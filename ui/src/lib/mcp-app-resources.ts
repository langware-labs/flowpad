import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { AssetEditor, editorForPath, FSRef, fsManager, TypeId, VFSPath } from '@sdk';

export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';
export const FLOWPAD_LOCAL_UI_PREFIX = 'ui://flowpad-local/';

const TEXT_MIME_BY_EXT: Record<string, string> = {
  '.css': 'text/css',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.mjs': 'text/javascript',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
};

function extensionOf(path: string): string {
  const withoutQuery = path.split(/[?#]/, 1)[0] ?? path;
  const idx = withoutQuery.lastIndexOf('.');
  return idx === -1 ? '' : withoutQuery.slice(idx).toLowerCase();
}

export function inferTextMimeType(path: string, fallback = 'text/plain'): string {
  return TEXT_MIME_BY_EXT[extensionOf(path)] ?? fallback;
}

export function isMcpAppPath(path: string): boolean {
  // Delegates to the SDK's extension registry — single home of the suffix rule.
  return editorForPath(path) === AssetEditor.MCP_APP;
}

export function mcpAppResourceUriForPath(path: string): string {
  return `${FLOWPAD_LOCAL_UI_PREFIX}${encodeURIComponent(path)}`;
}

export function pathFromFlowpadLocalResourceUri(uri: string): string | null {
  if (!uri.startsWith(FLOWPAD_LOCAL_UI_PREFIX)) return null;
  return decodeURIComponent(uri.slice(FLOWPAD_LOCAL_UI_PREFIX.length));
}

export async function readFlowpadLocalResource(uri: string, computeNodeTypeId: TypeId): Promise<ReadResourceResult> {
  const path = pathFromFlowpadLocalResourceUri(uri);
  if (!path) {
    throw new Error(`Unsupported Flowpad local MCP resource URI: ${uri}`);
  }
  const text = await new FSRef(path.replace(/^\//, ''), computeNodeTypeId).read();
  return {
    contents: [{
      uri,
      mimeType: isMcpAppPath(path) ? MCP_APP_MIME_TYPE : inferTextMimeType(path),
      text,
    }],
  };
}

export async function readVfsResource(uri: string): Promise<ReadResourceResult> {
  const stripped = uri.replace(/^(ui|vfs):\/\//, '');
  const vfsPath = VFSPath.parse(stripped);
  if (!vfsPath.typeId) {
    throw new Error(`Unsupported resource URI: ${uri}`);
  }
  const bytes = await fsManager.download(vfsPath.typeId, vfsPath.entitySubPath);
  const text = typeof bytes === 'string' ? bytes : await bytes.text();
  const mimeType =
    uri.startsWith('ui://') && /\.html?$/i.test(vfsPath.entitySubPath)
      ? MCP_APP_MIME_TYPE
      : inferTextMimeType(vfsPath.entitySubPath);
  return { contents: [{ uri, mimeType, text }] };
}
