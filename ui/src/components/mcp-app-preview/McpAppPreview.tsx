import { AppRenderer } from '@mcp-ui/client';
import type { McpUiHostCapabilities, McpUiMessageRequest, McpUiMessageResult, McpUiUpdateModelContextRequest } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { CallToolRequest, CallToolResult, JSONRPCRequest, ReadResourceRequest } from '@modelcontextprotocol/sdk/types.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { isReadyForInput, type AgenticProcess } from '@sdk';
import { useAgentContext } from '@src/contexts/agent-context';
import {
  MCP_APP_MIME_TYPE,
  isMcpAppPath,
  mcpAppResourceUriForPath,
  readFlowpadLocalResource,
} from '@src/lib/mcp-app-resources';
import { SANDBOX_URL } from '@src/lib/mcp-sandbox';
import { useCallback, useMemo, useRef, useState } from 'react';
import '@src/lib/mcp-host.css';

const HOST_INFO = { name: 'Flowpad', version: '1.0.0' } as const;
const TOOL_NAME = 'flowpad-local-mcp-ui';

const HOST_CAPABILITIES: McpUiHostCapabilities = {
  openLinks: {},
  logging: {},
  serverResources: {},
  message: { text: {}, structuredContent: {} },
  updateModelContext: { text: {}, structuredContent: {} },
};

interface McpAppPreviewProps {
  path: string;
  process: AgenticProcess | null;
  refreshKey?: number;
}

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function contentBlocksToText(content: McpUiMessageRequest['params']['content']): string {
  return content
    .map((block) => {
      if (block.type === 'text') return block.text;
      return `[${block.type} content] ${compactJson(block)}`;
    })
    .join('\n');
}

function buildAgentPrompt(
  message: McpUiMessageRequest['params'],
  context: McpUiUpdateModelContextRequest['params'] | null,
): string {
  const parts = [
    'An MCP App UI submitted data from the user.',
    '',
    'User message from ui/message:',
    contentBlocksToText(message.content),
  ];
  if (context) {
    parts.push('', 'Latest ui/update-model-context payload:', compactJson(context));
  }
  parts.push(
    '',
    'Reply with the exact marker MCP_UI_RECEIVED and echo every submitted field, including uploaded file name and preview text.',
  );
  return parts.join('\n');
}

function processReadyForPrompt(process: AgenticProcess): boolean {
  return !process.isPrompting && isReadyForInput(process);
}

function isPromptBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(already.*(running|in flight)|in flight|409|busy)/i.test(message);
}

async function waitForPromptReady(process: AgenticProcess, timeoutMs = 120_000): Promise<void> {
  if (processReadyForPrompt(process)) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubState();
      unsubPrompting();
      resolve();
    };
    const check = () => {
      if (processReadyForPrompt(process)) done();
    };
    const timer = window.setTimeout(done, timeoutMs);
    const unsubState = process.on('state_change', check);
    const unsubPrompting = process.on('prompting-change', check);
    check();
  });
}

async function promptWhenReady(process: AgenticProcess, prompt: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await waitForPromptReady(process);
    try {
      await process.prompt(prompt);
      return;
    } catch (e) {
      if (!isPromptBusyError(e) || attempt === 3) throw e;
      // loop head re-awaits readiness before the next prompt attempt
    }
  }
}

async function handleCallTool(params: CallToolRequest['params']): Promise<CallToolResult> {
  return {
    content: [{
      type: 'text',
      text: `Tool '${params.name}' is not routed through the Flowpad Vibe MCP App preview.`,
    }],
    isError: true,
  };
}

export function McpAppPreview({ path, process, refreshKey }: McpAppPreviewProps) {
  const { computeNode } = useAgentContext();
  const [error, setError] = useState<string | null>(null);
  const latestModelContextRef = useRef<McpUiUpdateModelContextRequest['params'] | null>(null);

  const resourceUri = useMemo(() => mcpAppResourceUriForPath(path), [path]);

  const handleReadResource = useCallback(
    async (params: ReadResourceRequest['params']) => {
      if (!computeNode?.typeId) {
        throw new Error('No compute node is available for local MCP App resource reads.');
      }
      return readFlowpadLocalResource(params.uri, computeNode.typeId);
    },
    [computeNode?.typeId],
  );

  const handleMessage = useCallback(
    async (params: McpUiMessageRequest['params']): Promise<McpUiMessageResult> => {
      if (!process) return { isError: true };
      const prompt = buildAgentPrompt(params, latestModelContextRef.current);
      promptWhenReady(process, prompt).catch((e) => {
        console.error('[McpAppPreview] failed to deliver Vibe agent prompt from ui/message', e);
      });
      return {};
    },
    [process],
  );

  const handleFallbackRequest = useCallback(async (request: JSONRPCRequest) => {
    if (request.method === 'ui/update-model-context') {
      latestModelContextRef.current = (request.params ?? {}) as McpUiUpdateModelContextRequest['params'];
      return {};
    }
    throw new McpError(ErrorCode.MethodNotFound, `No MCP App preview handler for method: ${request.method}`);
  }, []);

  const handleError = useCallback((err: Error) => setError(err.message), []);

  if (!isMcpAppPath(path)) return null;

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-destructive" data-testid="mcp-app-preview-error">
        {error}
      </div>
    );
  }

  return (
    <div className="flowpad-app-host" data-testid="mcp-app-preview" data-refresh-key={refreshKey ?? 0}>
      <AppRenderer
        key={`${resourceUri}:${refreshKey ?? 0}`}
        toolName={TOOL_NAME}
        toolResourceUri={resourceUri}
        toolInput={{ path, source: 'flow-show', mimeType: MCP_APP_MIME_TYPE }}
        sandbox={{ url: SANDBOX_URL }}
        hostInfo={HOST_INFO}
        hostCapabilities={HOST_CAPABILITIES}
        onCallTool={handleCallTool}
        onReadResource={handleReadResource}
        onMessage={handleMessage}
        onFallbackRequest={handleFallbackRequest}
        onLoggingMessage={(msg) => console.debug('[McpAppPreview]', msg)}
        onError={handleError}
      />
    </div>
  );
}

export default McpAppPreview;
