import { AppRenderer } from '@mcp-ui/client';
import type { CallToolResult, ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { fsManager, VFSPath } from '@sdk';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { SANDBOX_URL } from '@src/lib/mcp-sandbox';
import { isInternalDockUrl, parseDockUrlToPointer } from '@src/components/app-host/dock-url-helpers';
import '@src/lib/mcp-host.css';

const DEFAULT_PAGE = 'index';
const DEFAULT_COMPONENT = 'main';
const HOST_INFO = { name: 'Flowpad', version: '1.0.0' } as const;

interface ParsedShowParams {
  entityVfs: string;
  page: string;
  component: string;
}

function parseShowParams(
  pointer: string | undefined,
  page: string | undefined,
  component: string | undefined,
): ParsedShowParams | null {
  if (!pointer) return null;
  return {
    entityVfs: pointer,
    page: page || DEFAULT_PAGE,
    component: component || DEFAULT_COMPONENT,
  };
}

async function fetchSkillUIHtml(entityVfs: string, component: string): Promise<string> {
  const vfsPath = VFSPath.parse(entityVfs);
  if (!vfsPath.typeId) {
    throw new Error(`VFS path does not contain a valid TypeId: ${entityVfs}`);
  }
  const htmlPath = `${vfsPath.entitySubPath}/ui/${component}.html`;
  const content = await fsManager.download(vfsPath.typeId, htmlPath);
  if (typeof content !== 'string') {
    throw new Error(`Skill UI content is not a string: ${entityVfs}/ui/${component}.html`);
  }
  return content;
}

async function readResource(uri: string): Promise<ReadResourceResult> {
  const stripped = uri.replace(/^(ui|vfs):\/\//, '');
  const vfsPath = VFSPath.parse(stripped);
  if (!vfsPath.typeId) {
    throw new Error(`Unsupported resource URI: ${uri}`);
  }
  const bytes = await fsManager.download(vfsPath.typeId, vfsPath.entitySubPath);
  const text = typeof bytes === 'string' ? bytes : await bytes.text();
  // TODO: detect MIME from extension or have fsManager return Content-Type;
  // hardcoded text/plain will mis-label any binary resource (png, audio, pdf).
  return { contents: [{ uri, mimeType: 'text/plain', text }] };
}

async function handleCallTool(params: { name: string }): Promise<CallToolResult> {
  return {
    content: [
      {
        type: 'text',
        text: `Tool '${params.name}' is not yet routed through the Flowpad SDK.`,
      },
    ],
    isError: true,
  };
}

async function handleReadResource(params: { uri: string }) {
  return readResource(params.uri);
}

async function handleMessage() {
  return {};
}

export function ShowView() {
  const { currentDock, navigation } = useDockNavigation();

  const handleOpenLink = useCallback(
    async ({ url }: { url: string }) => {
      if (isInternalDockUrl(url)) {
        const pointer = parseDockUrlToPointer(url);
        if (pointer) {
          navigation.openDock(pointer);
          return {};
        }
      }
      window.open(url, '_blank', 'noopener,noreferrer');
      return {};
    },
    [navigation],
  );
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const params = useMemo(
    () => parseShowParams(currentDock?.pointer, currentDock?.options?.page, currentDock?.options?.component),
    [currentDock?.pointer, currentDock?.options?.page, currentDock?.options?.component],
  );

  const handleError = useCallback((err: Error) => setError(err.message), []);

  useEffect(() => {
    if (!params) return;
    let cancelled = false;
    setError(null);
    setHtml(null);

    fetchSkillUIHtml(params.entityVfs, params.component).then(
      (h) => {
        if (!cancelled) setHtml(h);
      },
      (e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      },
    );

    return () => {
      cancelled = true;
    };
  }, [params]);

  if (!params) {
    return (
      <div className="h-full w-full p-8 font-mono">
        <h2 className="mb-4 text-xl font-bold">Invalid Show Path</h2>
        <p>Expected format: /dock/show/&lt;entity-vfs&gt;?page=&lt;page&gt;&amp;component=&lt;component&gt;</p>
        <p className="mt-2 text-sm text-gray-600">
          Defaults: page=&quot;{DEFAULT_PAGE}&quot;, component=&quot;{DEFAULT_COMPONENT}&quot;
        </p>
        <p className="mt-2">Received pointer: {currentDock?.pointer || 'none'}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full w-full p-8 font-mono text-red-600">
        <h2 className="mb-4 text-xl font-bold">Error Loading Component</h2>
        <p>{error}</p>
      </div>
    );
  }

  if (html === null) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <p className="text-gray-500">Loading MCP UI component...</p>
      </div>
    );
  }

  return (
    <div className="flowpad-app-host">
      <AppRenderer
        html={html}
        toolName={params.component}
        toolInput={{ entityVfs: params.entityVfs, page: params.page, component: params.component }}
        sandbox={{ url: SANDBOX_URL }}
        hostInfo={HOST_INFO}
        onCallTool={handleCallTool}
        onReadResource={handleReadResource}
        onMessage={handleMessage}
        onOpenLink={handleOpenLink}
        onError={handleError}
      />
    </div>
  );
}
