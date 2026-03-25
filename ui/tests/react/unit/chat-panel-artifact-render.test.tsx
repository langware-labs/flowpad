/**
 * Chat Panel Artifact Rendering Test
 *
 * Tests that all ArtifactSection components are rendered during streaming,
 * not just after streaming completes or on page refresh.
 *
 * This validates the bug where some RESULT elements are missing during streaming
 * but appear correctly after refresh.
 */

import { Flow, FlowData, FlowElementTypes, FlowEvents } from '@sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import React, { useCallback, useRef, useSyncExternalStore } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { AgenticProcessMock as FlowMock } from '../../utils/stub/agentic_process_mock';
import { unitTestSetup } from '../../utils/test-utils';

// Simplified ChatPanel that mimics the real useSyncExternalStore pattern
function SimpleChatPanel({ flow }: { flow: Flow }) {
  // Cache snapshot to avoid infinite loops - matches real implementation
  const snapshotRef = useRef<readonly FlowData[]>([]);
  // Track data property references to detect when FlowData.data changes (FlowData objects are mutable)
  const dataRefsRef = useRef<Map<FlowData, any>>(new Map());

  // Subscribe to flow stream changes - matches real implementation
  // Listen to both DATA (element starts) and DATA_END (element complete, data populated)
  // This ensures we detect when FlowData.data gets populated during streaming
  const subscribe = useCallback(
    (callback: () => void) => {
      const handler = () => callback();
      flow.on(FlowEvents.DATA, handler);
      flow.on(FlowEvents.DATA_END, handler);
      return () => {
        flow.off(FlowEvents.DATA, handler);
        flow.off(FlowEvents.DATA_END, handler);
      };
    },
    [flow],
  );

  const getSnapshot = useCallback(() => {
    const currentItems = flow.stream.items || [];

    // Check if array length changed
    const lengthChanged = currentItems.length !== snapshotRef.current.length;

    // Check if any item references changed (new items added/removed)
    const itemsChanged = currentItems.some((item, i) => item !== snapshotRef.current[i]);

    // Check if any FlowData.data content changed (FlowData objects are mutable)
    // This is critical for RESULT elements whose data property gets populated during streaming
    const contentChanged = currentItems.some((item, i) => {
      const oldItem = snapshotRef.current[i];
      if (item !== oldItem) return true; // Different item reference
      if (!oldItem) return false;

      // Compare data property reference - if it changed, content changed
      const oldDataRef = dataRefsRef.current.get(oldItem);
      const newDataRef = item.data;

      if (oldDataRef !== newDataRef) {
        // Update the reference tracker
        dataRefsRef.current.set(item, newDataRef);
        return true; // Content changed
      }

      return false;
    });

    // If anything changed, create a new array reference for React to detect
    if (lengthChanged || itemsChanged || contentChanged) {
      snapshotRef.current = [...currentItems];
      // Update data refs for all items
      dataRefsRef.current.clear();
      currentItems.forEach((item) => {
        dataRefsRef.current.set(item, item.data);
      });
    }

    return snapshotRef.current;
  }, [flow]);

  const chat = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // Filter for RESULT elements only (like the real ChatPanel filters chatFlowData)
  const resultItems = chat.filter((item) => item.elementType === FlowElementTypes.RESULT);

  return (
    <div data-testid="chat-panel">
      <div data-testid="artifact-count">Count: {resultItems.length}</div>
      {resultItems.map((flowData, i) => {
        const artifactData = flowData.data;
        const path = artifactData?.path || 'unknown';
        return (
          <div key={`${flowData.timestamp}-${flowData.index}-${i}`} data-testid={`artifact-${i}`}>
            <div data-testid={`artifact-path-${i}`}>{path}</div>
            <div data-testid={`artifact-index-${i}`}>Index: {flowData.index}</div>
          </div>
        );
      })}
    </div>
  );
}

describe('Chat Panel - Artifact Rendering', () => {
  let queryClient: QueryClient;
  let flowMock: FlowMock;

  beforeEach(async () => {
    await unitTestSetup();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    flowMock = new FlowMock({ id: '550e8400-e29b-41d4-a716-446655440100' });
    flowMock.streamChunkDelay = 10; // Fast streaming for tests
  });

  it('should render all 6 ArtifactSection components during streaming with break markers', async () => {
    const mockXML =
      '<flow-prompt-echo i="1721" t="2025-12-07T11:57:17.855245+00:00" data-type="string">create 6 .yml files, each containing only 1 character</flow-prompt-echo>' +
      '<flow-reasoning i="1722" t="2025-12-07T11:57:27.365870+00:00" data-type="string">The user wants me to create 6 .yml files, each containing only 1 character. This is a simple and straightforward task. I should create 6 different .yml files with single characters in them.</flow-reasoning>' +
      '||' +
      '<flow-chat i="1772" t="2025-12-07T11:57:30.282084+00:00" data-type="string">I\'ll create 6 .yml files, each containing a single character.</flow-chat>' +
      '<flow-write i="1777" t="2025-12-07T11:57:30.768419+00:00" focus="editor" data-type="string" path="file1.yml"></flow-write>' +
      '||' +
      '<flow-status i="1778" t="2025-12-07T11:57:30.768918+00:00" data-type="string">Creating file...</flow-status>' +
      '||' +
      '<flow-write i="1779" t="2025-12-07T11:57:30.769927+00:00" focus="editor" data-type="string" path="file1.yml">a</flow-write>' +
      '||' +
      '<flow-status i="1780" t="2025-12-07T11:57:30.843864+00:00" data-type="string">Thinking...</flow-status>' +
      '<flow-chat i="1781" t="2025-12-07T11:57:30.844279+00:00" data-type="string"></flow-chat>' +
      '||' +
      '<flow-write i="1783" t="2025-12-07T11:57:30.988512+00:00" focus="editor" data-type="string" path="file2.yml"></flow-write>' +
      '||' +
      '<flow-status i="1784" t="2025-12-07T11:57:30.988952+00:00" data-type="string">Creating file...</flow-status>' +
      '||' +
      '<flow-write i="1785" t="2025-12-07T11:57:30.989393+00:00" focus="editor" data-type="string" path="file2.yml">b</flow-write>' +
      '||' +
      '<flow-status i="1786" t="2025-12-07T11:57:31.054850+00:00" data-type="string">Thinking...</flow-status>' +
      '<flow-chat i="1787" t="2025-12-07T11:57:31.055313+00:00" data-type="string"></flow-chat>' +
      '||' +
      '<flow-write i="1789" t="2025-12-07T11:57:31.094906+00:00" focus="editor" data-type="string" path="file3.yml"></flow-write>' +
      '||' +
      '<flow-status i="1790" t="2025-12-07T11:57:31.106339+00:00" data-type="string">Creating file...</flow-status>' +
      '||' +
      '<flow-write i="1791" t="2025-12-07T11:57:31.118635+00:00" focus="editor" data-type="string" path="file3.yml">c</flow-write>' +
      '||' +
      '<flow-status i="1792" t="2025-12-07T11:57:31.225831+00:00" data-type="string">Thinking...</flow-status>' +
      '||' +
      '<flow-chat i="1793" t="2025-12-07T11:57:31.228063+00:00" data-type="string"></flow-chat>' +
      '<flow-write i="1795" t="2025-12-07T11:57:31.246705+00:00" focus="editor" data-type="string" path="file4.yml"></flow-write>' +
      '||' +
      '<flow-status i="1796" t="2025-12-07T11:57:31.252865+00:00" data-type="string">Creating file...</flow-status>' +
      '||' +
      '<flow-write i="1797" t="2025-12-07T11:57:31.271683+00:00" focus="editor" data-type="string" path="file4.yml">d</flow-write>' +
      '||' +
      '<flow-status i="1798" t="2025-12-07T11:57:31.401090+00:00" data-type="string">Thinking...</flow-status>' +
      '||' +
      '<flow-chat i="1799" t="2025-12-07T11:57:31.405473+00:00" data-type="string"></flow-chat>' +
      '||' +
      '<flow-write i="1801" t="2025-12-07T11:57:31.422825+00:00" focus="editor" data-type="string" path="file5.yml"></flow-write>' +
      '||' +
      '<flow-status i="1802" t="2025-12-07T11:57:31.427909+00:00" data-type="string">Creating file...</flow-status>' +
      '||' +
      '<flow-write i="1803" t="2025-12-07T11:57:31.429135+00:00" focus="editor" data-type="string" path="file5.yml">e</flow-write>' +
      '||' +
      '<flow-status i="1804" t="2025-12-07T11:57:31.522030+00:00" data-type="string">Thinking...</flow-status>' +
      '||' +
      '<flow-chat i="1805" t="2025-12-07T11:57:31.523295+00:00" data-type="string"></flow-chat>' +
      '||' +
      '<flow-write i="1807" t="2025-12-07T11:57:31.534787+00:00" focus="editor" data-type="string" path="file6.yml"></flow-write>' +
      '||' +
      '<flow-status i="1808" t="2025-12-07T11:57:31.540970+00:00" data-type="string">Creating file...</flow-status>' +
      '||' +
      '<flow-write i="1809" t="2025-12-07T11:57:31.542218+00:00" focus="editor" data-type="string" path="file6.yml">f</flow-write>' +
      '||' +
      '<flow-status i="1810" t="2025-12-07T11:57:31.612373+00:00" data-type="string">Thinking...</flow-status>' +
      '||' +
      '<flow-chat i="1811" t="2025-12-07T11:57:31.613831+00:00" data-type="string">Done! I\'ve created 6 .yml files, each containing a single character (a, b, c, d, e, f).</flow-chat>' +
      '||<flow-result i="1819" t="2025-12-07T11:57:32.332670+00:00" data-type="entity">{"type":"artifact","id":"43ce0e8a-ac42-4a5b-adb1-6a61541bd385","created_by":"8aebc757-6c62-4311-8ab6-54349f4fdfa5","created_date":"2025-12-07T11:57:32.335777Z","updated_by":"8aebc757-6c62-4311-8ab6-54349f4fdfa5","updated_date":"2025-12-07T11:57:32.335777Z","expand":{"roles":null,"allowed_actions":null,"auth_scopes":null,"is_private":null,"expansions":null},"name":"file1.yml","ref_type":"FILE","path":"file1.yml","description":"YML file containing the character \'a\'","metadata":{},"artifact_type":"FILE","generating_flow_id":"a2948c21-703a-4240-9f92-943e0a4803cb"}</flow-result>' +
      '||<flow-chat i="1820" t="2025-12-07T11:57:32.458268+00:00" data-type="string"></flow-chat>' +
      '||<flow-result i="1821" t="2025-12-07T11:57:32.620523+00:00" data-type="entity">{"type":"artifact","id":"656d58b6-2d0c-4d98-88dd-0048f8c1d166","created_by":"8aebc757-6c62-4311-8ab6-54349f4fdfa5","created_date":"2025-12-07T11:57:32.622701Z","updated_by":"8aebc757-6c62-4311-8ab6-54349f4fdfa5","updated_date":"2025-12-07T11:57:32.622701Z","expand":{"roles":null,"allowed_actions":null,"auth_scopes":null,"is_private":null,"expansions":null},"name":"file2.yml","ref_type":"FILE","path":"file2.yml","description":"YML file containing the character \'b\'","metadata":{},"artifact_type":"FILE","generating_flow_id":"a2948c21-703a-4240-9f92-943e0a4803cb"}</flow-result>' +
      '||<flow-chat i="1822" t="2025-12-07T11:57:32.694327+00:00" data-type="string"></flow-chat>' +
      '||<flow-result i="1823" t="2025-12-07T11:57:32.860286+00:00" data-type="entity">{"type":"artifact","id":"993b32b1-3577-45b3-b81e-1b7fdbbcdedb","created_by":"8aebc757-6c62-4311-8ab6-54349f4fdfa5","created_date":"2025-12-07T11:57:32.862316Z","updated_by":"8aebc757-6c62-4311-8ab6-54349f4fdfa5","updated_date":"2025-12-07T11:57:32.862316Z","expand":{"roles":null,"allowed_actions":null,"auth_scopes":null,"is_private":null,"expansions":null},"name":"file3.yml","ref_type":"FILE","path":"file3.yml","description":"YML file containing the character \'c\'","metadata":{},"artifact_type":"FILE","generating_flow_id":"a2948c21-703a-4240-9f92-943e0a4803cb"}</flow-result>' +
      '||<flow-chat i="1824" t="2025-12-07T11:57:32.942599+00:00" data-type="string"></flow-chat>' +
      '||<flow-result i="1825" t="2025-12-07T11:57:33.121073+00:00" data-type="entity">{"type":"artifact","id":"9dae6864-b54a-472c-98f6-1dea97cf4ec3","created_by":"8aebc757-6c62-4311-8ab6-54349f4fdfa5","created_date":"2025-12-07T11:57:33.123234Z","updated_by":"8aebc757-6c62-4311-8ab6-54349f4fdfa5","updated_date":"2025-12-07T11:57:33.123234Z","expand":{"roles":null,"allowed_actions":null,"auth_scopes":null,"is_private":null,"expansions":null},"name":"file4.yml","ref_type":"FILE","path":"file4.yml","description":"YML file containing the character \'d\'","metadata":{},"artifact_type":"FILE","generating_flow_id":"a2948c21-703a-4240-9f92-943e0a4803cb"}</flow-result>' +
      '||<flow-chat i="1826" t="2025-12-07T11:57:33.204068+00:00" data-type="string"></flow-chat>' +
      '||<flow-result i="1827" t="2025-12-07T11:57:33.414527+00:00" data-type="entity">{"type":"artifact","id":"b5087342-6733-4068-b012-8fdc38ddd457","created_by":"8aebc757-6c62-4311-8ab6-54349f4fdfa5","created_date":"2025-12-07T11:57:33.417591Z","updated_by":"8aebc757-6c62-4311-8ab6-54349f4fdfa5","updated_date":"2025-12-07T11:57:33.417591Z","expand":{"roles":null,"allowed_actions":null,"auth_scopes":null,"is_private":null,"expansions":null},"name":"file5.yml","ref_type":"FILE","path":"file5.yml","description":"YML file containing the character \'e\'","metadata":{},"artifact_type":"FILE","generating_flow_id":"a2948c21-703a-4240-9f92-943e0a4803cb"}</flow-result>' +
      '||<flow-chat i="1828" t="2025-12-07T11:57:33.499310+00:00" data-type="string"></flow-chat>' +
      '||<flow-result i="1829" t="2025-12-07T11:57:33.631465+00:00" data-type="entity">{"type":"artifact","id":"f44514e8-4266-41b4-bb90-fed488f72e6c","created_by":"8aebc757-6c62-4311-8ab6-54349f4fdfa5","created_date":"2025-12-07T11:57:33.633628Z","updated_by":"8aebc757-6c62-4311-8ab6-54349f4fdfa5","updated_date":"2025-12-07T11:57:33.633628Z","expand":{"roles":null,"allowed_actions":null,"auth_scopes":null,"is_private":null,"expansions":null},"name":"file6.yml","ref_type":"FILE","path":"file6.yml","description":"YML file containing the character \'f\'","metadata":{},"artifact_type":"FILE","generating_flow_id":"a2948c21-703a-4240-9f92-943e0a4803cb"}</flow-result>' +
      '<flow-checkpoint i="1830" t="2025-12-07T11:57:33.896018+00:00" data-type="string" checkpoint_hash="622a75c7229a74da25aef2fb33b2548695f4f623"></flow-checkpoint>' +
      '<flow-llm-end i="1831" t="2025-12-07T11:57:33.896422+00:00" data-type="string">LLM generation complete</flow-llm-end>';

    flowMock.setMockStreamXML(mockXML);

    // Render chat panel
    render(
      <QueryClientProvider client={queryClient}>
        <SimpleChatPanel flow={flowMock} />
      </QueryClientProvider>,
    );

    // Start streaming
    const _sendPromise = flowMock.sendMessage('test');

    // Track artifact count as it increases during streaming
    const artifactCounts: number[] = [];

    // Monitor artifact count during streaming
    const checkArtifactCount = () => {
      const countElement = screen.queryByTestId('artifact-count');
      if (countElement) {
        const countText = countElement.textContent || '';
        const match = countText.match(/Count: (\d+)/);
        if (match) {
          const count = parseInt(match[1], 10);
          if (artifactCounts.length === 0 || artifactCounts[artifactCounts.length - 1] !== count) {
            artifactCounts.push(count);
          }
        }
      }
    };

    // Wait for streaming to complete
    await waitFor(() => expect(flowMock.executionStatus).toBe('Ready'), { timeout: 5000 });

    // Wait a bit more for React to render all artifacts
    await waitFor(
      () => {
        checkArtifactCount();
        const countElement = screen.getByTestId('artifact-count');
        expect(countElement).toHaveTextContent('Count: 6');
      },
      { timeout: 2000 },
    );

    // Verify all 6 artifacts are rendered
    expect(screen.getByTestId('artifact-0')).toBeInTheDocument();
    expect(screen.getByTestId('artifact-1')).toBeInTheDocument();
    expect(screen.getByTestId('artifact-2')).toBeInTheDocument();
    expect(screen.getByTestId('artifact-3')).toBeInTheDocument();
    expect(screen.getByTestId('artifact-4')).toBeInTheDocument();
    expect(screen.getByTestId('artifact-5')).toBeInTheDocument();

    // Verify artifact paths
    expect(screen.getByTestId('artifact-path-0')).toHaveTextContent('file1.yml');
    expect(screen.getByTestId('artifact-path-1')).toHaveTextContent('file2.yml');
    expect(screen.getByTestId('artifact-path-2')).toHaveTextContent('file3.yml');
    expect(screen.getByTestId('artifact-path-3')).toHaveTextContent('file4.yml');
    expect(screen.getByTestId('artifact-path-4')).toHaveTextContent('file5.yml');
    expect(screen.getByTestId('artifact-path-5')).toHaveTextContent('file6.yml');

    // Verify artifact indices
    expect(screen.getByTestId('artifact-index-0')).toHaveTextContent('Index: 1819');
    expect(screen.getByTestId('artifact-index-1')).toHaveTextContent('Index: 1821');
    expect(screen.getByTestId('artifact-index-2')).toHaveTextContent('Index: 1823');
    expect(screen.getByTestId('artifact-index-3')).toHaveTextContent('Index: 1825');
    expect(screen.getByTestId('artifact-index-4')).toHaveTextContent('Index: 1827');
    expect(screen.getByTestId('artifact-index-5')).toHaveTextContent('Index: 1829');

    // Verify we saw progressive rendering (count increased during streaming)
    // This ensures artifacts appeared during streaming, not just at the end
    expect(artifactCounts.length).toBeGreaterThan(0);
    expect(artifactCounts[artifactCounts.length - 1]).toBe(6);
  });

  it('should render all 6 ArtifactSection components during streaming with part of break markers', async () => {
    const mockXML =
      '<flow-prompt-echo i="1721" t="2025-12-07T11:57:17.855245+00:00" data-type="string">create 6 .yml files, each containing only 1 character</flow-prompt-echo>' +
      '<flow-reasoning i="1722" t="2025-12-07T11:57:27.365870+00:00" data-type="string">The user wants me to create 6 .yml files, each containing only 1 character. This is a simple and straightforward task. I should create 6 different .yml files with single characters in them.</flow-reasoning>' +
      '||' +
      '<flow-chat i="1772" t="2025-12-07T11:57:30.282084+00:00" data-type="string">I\'ll create 6 .yml files, each containing a single character.</flow-chat>' +
      '<flow-write i="1777" t="2025-12-07T11:57:30.768419+00:00" focus="editor" data-type="string" path="file1.yml"></flow-write>' +
      '||' +
      '<flow-status i="1778" t="2025-12-07T11:57:30.768918+00:00" data-type="string">Creating file...</flow-status>' +
      '||' +
      '<flow-write i="1779" t="2025-12-07T11:57:30.769927+00:00" focus="editor" data-type="string" path="file1.yml">a</flow-write>' +
      '||' +
      '<flow-status i="1780" t="2025-12-07T11:57:30.843864+00:00" data-type="string">Thinking...</flow-status>' +
      '<flow-chat i="1781" t="2025-12-07T11:57:30.844279+00:00" data-type="string"></flow-chat>' +
      '||' +
      '<flow-write i="1783" t="2025-12-07T11:57:30.988512+00:00" focus="editor" data-type="string" path="file2.yml"></flow-write>' +
      '||' +
      '<flow-status i="1784" t="2025-12-07T11:57:30.988952+00:00" data-type="string">Creating file...</flow-status>' +
      '||' +
      '<flow-write i="1785" t="2025-12-07T11:57:30.989393+00:00" focus="editor" data-type="string" path="file2.yml">b</flow-write>' +
      '||' +
      '<flow-status i="1786" t="2025-12-07T11:57:31.054850+00:00" data-type="string">Thinking...</flow-status>' +
      '<flow-chat i="1787" t="2025-12-07T11:57:31.055313+00:00" data-type="string"></flow-chat>' +
      '||' +
      '<flow-write i="1789" t="2025-12-07T11:57:31.094906+00:00" focus="editor" data-type="string" path="file3.yml"></flow-write>' +
      '||' +
      '<flow-status i="1790" t="2025-12-07T11:57:31.106339+00:00" data-type="string">Creating file...</flow-status>' +
      '||' +
      '<flow-write i="1791" t="2025-12-07T11:57:31.118635+00:00" focus="editor" data-type="string" path="file3.yml">c</flow-write>' +
      '||' +
      '<flow-status i="1792" t="2025-12-07T11:57:31.225831+00:00" data-type="string">Thinking...</flow-status>' +
      '||' +
      '<flow-chat i="1793" t="2025-12-07T11:57:31.228063+00:00" data-type="string"></flow-chat>' +
      '<flow-write i="1795" t="2025-12-07T11:57:31.246705+00:00" focus="editor" data-type="string" path="file4.yml"></flow-write>' +
      '||' +
      '<flow-status i="1796" t="2025-12-07T11:57:31.252865+00:00" data-type="string">Creating file...</flow-status>' +
      '||' +
      '<flow-write i="1797" t="2025-12-07T11:57:31.271683+00:00" focus="editor" data-type="string" path="file4.yml">d</flow-write>' +
      '||' +
      '<flow-status i="1798" t="2025-12-07T11:57:31.401090+00:00" data-type="string">Thinking...</flow-status>' +
      '||' +
      '<flow-chat i="1799" t="2025-12-07T11:57:31.405473+00:00" data-type="string"></flow-chat>' +
      '||' +
      '<flow-write i="1801" t="2025-12-07T11:57:31.422825+00:00" focus="editor" data-type="string" path="file5.yml"></flow-write>' +
      '||' +
      '<flow-status i="1802" t="2025-12-07T11:57:31.427909+00:00" data-type="string">Creating file...</flow-status>' +
      '||' +
      '<flow-write i="1803" t="2025-12-07T11:57:31.429135+00:00" focus="editor" data-type="string" path="file5.yml">e</flow-write>' +
      '||' +
      '<flow-status i="1804" t="2025-12-07T11:57:31.522030+00:00" data-type="string">Thinking...</flow-status>' +
      '||' +
      '<flow-chat i="1805" t="2025-12-07T11:57:31.523295+00:00" data-type="string"></flow-chat>' +
      '||' +
      '<flow-write i="1807" t="2025-12-07T11:57:31.534787+00:00" focus="editor" data-type="string" path="file6.yml"></flow-write>' +
      '||' +
      '<flow-status i="1808" t="2025-12-07T11:57:31.540970+00:00" data-type="string">Creating file...</flow-status>' +
      '||' +
      '<flow-write i="1809" t="2025-12-07T11:57:31.542218+00:00" focus="editor" data-type="string" path="file6.yml">f</flow-write>' +
      '||' +
      '<flow-status i="1810" t="2025-12-07T11:57:31.612373+00:00" data-type="string">Thinking...</flow-status>' +
      '||' +
      '<flow-chat i="1811" t="2025-12-07T11:57:31.613831+00:00" data-type="string">Done! I\'ve created 6 .yml files, each containing a single character (a, b, c, d, e, f).</flow-chat>' +
      '<flow-result i="1819" t="2025-12-07T11:57:32.332670+00:00" data-type="entity">{"type":"artifact","id":"43ce0e8a-ac42-4a5b-adb1-6a61541bd385","created_by":"8aebc757-6c62-4311-8ab6-54349f4fdfa5","created_date":"2025-12-07T11:57:32.335777Z","updated_by":"8aebc757-6c62-4311-8ab6-54349f4fdfa5","updated_date":"2025-12-07T11:57:32.335777Z","expand":{"roles":null,"allowed_actions":null,"auth_scopes":null,"is_private":null,"expansions":null},"name":"file1.yml","ref_type":"FILE","path":"file1.yml","description":"YML file containing the character \'a\'","metadata":{},"artifact_type":"FILE","generating_flow_id":"a2948c21-703a-4240-9f92-943e0a4803cb"}</flow-result>' +
      '<flow-chat i="1820" t="2025-12-07T11:57:32.458268+00:00" data-type="string"></flow-chat>' +
      '<flow-result i="1821" t="2025-12-07T11:57:32.620523+00:00" data-type="entity">{"type":"artifact","id":"656d58b6-2d0c-4d98-88dd-0048f8c1d166","created_by":"8aebc757-6c62-4311-8ab6-54349f4fdfa5","created_date":"2025-12-07T11:57:32.622701Z","updated_by":"8aebc757-6c62-4311-8ab6-54349f4fdfa5","updated_date":"2025-12-07T11:57:32.622701Z","expand":{"roles":null,"allowed_actions":null,"auth_scopes":null,"is_private":null,"expansions":null},"name":"file2.yml","ref_type":"FILE","path":"file2.yml","description":"YML file containing the character \'b\'","metadata":{},"artifact_type":"FILE","generating_flow_id":"a2948c21-703a-4240-9f92-943e0a4803cb"}</flow-result>' +
      '<flow-chat i="1822" t="2025-12-07T11:57:32.694327+00:00" data-type="string"></flow-chat>' +
      '<flow-result i="1823" t="2025-12-07T11:57:32.860286+00:00" data-type="entity">{"type":"artifact","id":"993b32b1-3577-45b3-b81e-1b7fdbbcdedb","created_by":"8aebc757-6c62-4311-8ab6-54349f4fdfa5","created_date":"2025-12-07T11:57:32.862316Z","updated_by":"8aebc757-6c62-4311-8ab6-54349f4fdfa5","updated_date":"2025-12-07T11:57:32.862316Z","expand":{"roles":null,"allowed_actions":null,"auth_scopes":null,"is_private":null,"expansions":null},"name":"file3.yml","ref_type":"FILE","path":"file3.yml","description":"YML file containing the character \'c\'","metadata":{},"artifact_type":"FILE","generating_flow_id":"a2948c21-703a-4240-9f92-943e0a4803cb"}</flow-result>' +
      '<flow-chat i="1824" t="2025-12-07T11:57:32.942599+00:00" data-type="string"></flow-chat>' +
      '||<flow-result i="1825" t="2025-12-07T11:57:33.121073+00:00" data-type="entity">{"type":"artifact","id":"9dae6864-b54a-472c-98f6-1dea97cf4ec3","created_by":"8aebc757-6c62-4311-8ab6-54349f4fdfa5","created_date":"2025-12-07T11:57:33.123234Z","updated_by":"8aebc757-6c62-4311-8ab6-54349f4fdfa5","updated_date":"2025-12-07T11:57:33.123234Z","expand":{"roles":null,"allowed_actions":null,"auth_scopes":null,"is_private":null,"expansions":null},"name":"file4.yml","ref_type":"FILE","path":"file4.yml","description":"YML file containing the character \'d\'","metadata":{},"artifact_type":"FILE","generating_flow_id":"a2948c21-703a-4240-9f92-943e0a4803cb"}</flow-result>' +
      '||<flow-chat i="1826" t="2025-12-07T11:57:33.204068+00:00" data-type="string"></flow-chat>' +
      '||<flow-result i="1827" t="2025-12-07T11:57:33.414527+00:00" data-type="entity">{"type":"artifact","id":"b5087342-6733-4068-b012-8fdc38ddd457","created_by":"8aebc757-6c62-4311-8ab6-54349f4fdfa5","created_date":"2025-12-07T11:57:33.417591Z","updated_by":"8aebc757-6c62-4311-8ab6-54349f4fdfa5","updated_date":"2025-12-07T11:57:33.417591Z","expand":{"roles":null,"allowed_actions":null,"auth_scopes":null,"is_private":null,"expansions":null},"name":"file5.yml","ref_type":"FILE","path":"file5.yml","description":"YML file containing the character \'e\'","metadata":{},"artifact_type":"FILE","generating_flow_id":"a2948c21-703a-4240-9f92-943e0a4803cb"}</flow-result>' +
      '||<flow-chat i="1828" t="2025-12-07T11:57:33.499310+00:00" data-type="string"></flow-chat>' +
      '<flow-result i="1829" t="2025-12-07T11:57:33.631465+00:00" data-type="entity">{"type":"artifact","id":"f44514e8-4266-41b4-bb90-fed488f72e6c","created_by":"8aebc757-6c62-4311-8ab6-54349f4fdfa5","created_date":"2025-12-07T11:57:33.633628Z","updated_by":"8aebc757-6c62-4311-8ab6-54349f4fdfa5","updated_date":"2025-12-07T11:57:33.633628Z","expand":{"roles":null,"allowed_actions":null,"auth_scopes":null,"is_private":null,"expansions":null},"name":"file6.yml","ref_type":"FILE","path":"file6.yml","description":"YML file containing the character \'f\'","metadata":{},"artifact_type":"FILE","generating_flow_id":"a2948c21-703a-4240-9f92-943e0a4803cb"}</flow-result>' +
      '<flow-checkpoint i="1830" t="2025-12-07T11:57:33.896018+00:00" data-type="string" checkpoint_hash="622a75c7229a74da25aef2fb33b2548695f4f623"></flow-checkpoint>' +
      '<flow-llm-end i="1831" t="2025-12-07T11:57:33.896422+00:00" data-type="string">LLM generation complete</flow-llm-end>';

    flowMock.setMockStreamXML(mockXML);

    // Render chat panel
    render(
      <QueryClientProvider client={queryClient}>
        <SimpleChatPanel flow={flowMock} />
      </QueryClientProvider>,
    );

    // Start streaming
    const _sendPromise = flowMock.sendMessage('test');

    // Track artifact count as it increases during streaming
    const artifactCounts: number[] = [];

    // Monitor artifact count during streaming
    const checkArtifactCount = () => {
      const countElement = screen.queryByTestId('artifact-count');
      if (countElement) {
        const countText = countElement.textContent || '';
        const match = countText.match(/Count: (\d+)/);
        if (match) {
          const count = parseInt(match[1], 10);
          if (artifactCounts.length === 0 || artifactCounts[artifactCounts.length - 1] !== count) {
            artifactCounts.push(count);
          }
        }
      }
    };

    // Wait for streaming to complete
    await waitFor(() => expect(flowMock.executionStatus).toBe('Ready'), { timeout: 5000 });

    // Wait a bit more for React to render all artifacts
    await waitFor(
      () => {
        checkArtifactCount();
        const countElement = screen.getByTestId('artifact-count');
        expect(countElement).toHaveTextContent('Count: 6');
      },
      { timeout: 2000 },
    );

    // Verify all 6 artifacts are rendered
    expect(screen.getByTestId('artifact-0')).toBeInTheDocument();
    expect(screen.getByTestId('artifact-1')).toBeInTheDocument();
    expect(screen.getByTestId('artifact-2')).toBeInTheDocument();
    expect(screen.getByTestId('artifact-3')).toBeInTheDocument();
    expect(screen.getByTestId('artifact-4')).toBeInTheDocument();
    expect(screen.getByTestId('artifact-5')).toBeInTheDocument();

    // Verify artifact paths
    expect(screen.getByTestId('artifact-path-0')).toHaveTextContent('file1.yml');
    expect(screen.getByTestId('artifact-path-1')).toHaveTextContent('file2.yml');
    expect(screen.getByTestId('artifact-path-2')).toHaveTextContent('file3.yml');
    expect(screen.getByTestId('artifact-path-3')).toHaveTextContent('file4.yml');
    expect(screen.getByTestId('artifact-path-4')).toHaveTextContent('file5.yml');
    expect(screen.getByTestId('artifact-path-5')).toHaveTextContent('file6.yml');

    // Verify artifact indices
    expect(screen.getByTestId('artifact-index-0')).toHaveTextContent('Index: 1819');
    expect(screen.getByTestId('artifact-index-1')).toHaveTextContent('Index: 1821');
    expect(screen.getByTestId('artifact-index-2')).toHaveTextContent('Index: 1823');
    expect(screen.getByTestId('artifact-index-3')).toHaveTextContent('Index: 1825');
    expect(screen.getByTestId('artifact-index-4')).toHaveTextContent('Index: 1827');
    expect(screen.getByTestId('artifact-index-5')).toHaveTextContent('Index: 1829');

    // Verify we saw progressive rendering (count increased during streaming)
    // This ensures artifacts appeared during streaming, not just at the end
    expect(artifactCounts.length).toBeGreaterThan(0);
    expect(artifactCounts[artifactCounts.length - 1]).toBe(6);
  });

  it('should render all 6 ArtifactSection components during streaming without break markers', async () => {
    const mockXML =
      '<flow-prompt-echo i="1721" t="2025-12-07T11:57:17.855245+00:00" data-type="string">create 6 .yml files, each containing only 1 character</flow-prompt-echo>' +
      '<flow-reasoning i="1722" t="2025-12-07T11:57:27.365870+00:00" data-type="string">The user wants me to create 6 .yml files, each containing only 1 character. This is a simple and straightforward task. I should create 6 different .yml files with single characters in them.</flow-reasoning>' +
      '<flow-chat i="1772" t="2025-12-07T11:57:30.282084+00:00" data-type="string">I\'ll create 6 .yml files, each containing a single character.</flow-chat>' +
      '<flow-write i="1777" t="2025-12-07T11:57:30.768419+00:00" focus="editor" data-type="string" path="file1.yml"></flow-write>' +
      '<flow-status i="1778" t="2025-12-07T11:57:30.768918+00:00" data-type="string">Creating file...</flow-status>' +
      '<flow-write i="1779" t="2025-12-07T11:57:30.769927+00:00" focus="editor" data-type="string" path="file1.yml">a</flow-write>' +
      '<flow-status i="1780" t="2025-12-07T11:57:30.843864+00:00" data-type="string">Thinking...</flow-status>' +
      '<flow-chat i="1781" t="2025-12-07T11:57:30.844279+00:00" data-type="string"></flow-chat>' +
      '<flow-write i="1783" t="2025-12-07T11:57:30.988512+00:00" focus="editor" data-type="string" path="file2.yml"></flow-write>' +
      '<flow-status i="1784" t="2025-12-07T11:57:30.988952+00:00" data-type="string">Creating file...</flow-status>' +
      '<flow-write i="1785" t="2025-12-07T11:57:30.989393+00:00" focus="editor" data-type="string" path="file2.yml">b</flow-write>' +
      '<flow-status i="1786" t="2025-12-07T11:57:31.054850+00:00" data-type="string">Thinking...</flow-status>' +
      '<flow-chat i="1787" t="2025-12-07T11:57:31.055313+00:00" data-type="string"></flow-chat>' +
      '<flow-write i="1789" t="2025-12-07T11:57:31.094906+00:00" focus="editor" data-type="string" path="file3.yml"></flow-write>' +
      '<flow-status i="1790" t="2025-12-07T11:57:31.106339+00:00" data-type="string">Creating file...</flow-status>' +
      '<flow-write i="1791" t="2025-12-07T11:57:31.118635+00:00" focus="editor" data-type="string" path="file3.yml">c</flow-write>' +
      '<flow-status i="1792" t="2025-12-07T11:57:31.225831+00:00" data-type="string">Thinking...</flow-status>' +
      '<flow-chat i="1793" t="2025-12-07T11:57:31.228063+00:00" data-type="string"></flow-chat>' +
      '<flow-write i="1795" t="2025-12-07T11:57:31.246705+00:00" focus="editor" data-type="string" path="file4.yml"></flow-write>' +
      '<flow-status i="1796" t="2025-12-07T11:57:31.252865+00:00" data-type="string">Creating file...</flow-status>' +
      '<flow-write i="1797" t="2025-12-07T11:57:31.271683+00:00" focus="editor" data-type="string" path="file4.yml">d</flow-write>' +
      '<flow-status i="1798" t="2025-12-07T11:57:31.401090+00:00" data-type="string">Thinking...</flow-status>' +
      '<flow-chat i="1799" t="2025-12-07T11:57:31.405473+00:00" data-type="string"></flow-chat>' +
      '<flow-write i="1801" t="2025-12-07T11:57:31.422825+00:00" focus="editor" data-type="string" path="file5.yml"></flow-write>' +
      '<flow-status i="1802" t="2025-12-07T11:57:31.427909+00:00" data-type="string">Creating file...</flow-status>' +
      '<flow-write i="1803" t="2025-12-07T11:57:31.429135+00:00" focus="editor" data-type="string" path="file5.yml">e</flow-write>' +
      '<flow-status i="1804" t="2025-12-07T11:57:31.522030+00:00" data-type="string">Thinking...</flow-status>' +
      '<flow-chat i="1805" t="2025-12-07T11:57:31.523295+00:00" data-type="string"></flow-chat>' +
      '<flow-write i="1807" t="2025-12-07T11:57:31.534787+00:00" focus="editor" data-type="string" path="file6.yml"></flow-write>' +
      '<flow-status i="1808" t="2025-12-07T11:57:31.540970+00:00" data-type="string">Creating file...</flow-status>' +
      '<flow-write i="1809" t="2025-12-07T11:57:31.542218+00:00" focus="editor" data-type="string" path="file6.yml">f</flow-write>' +
      '<flow-status i="1810" t="2025-12-07T11:57:31.612373+00:00" data-type="string">Thinking...</flow-status>' +
      '<flow-chat i="1811" t="2025-12-07T11:57:31.613831+00:00" data-type="string">Done! I\'ve created 6 .yml files, each containing a single character (a, b, c, d, e, f).</flow-chat>' +
      '<flow-result i="1819" t="2025-12-07T11:57:32.332670+00:00" data-type="entity">{"type":"artifact","id":"43ce0e8a-ac42-4a5b-adb1-6a61541bd385","created_by":"8aebc757-6c62-4311-8ab6-54349f4fdfa5","created_date":"2025-12-07T11:57:32.335777Z","updated_by":"8aebc757-6c62-4311-8ab6-54349f4fdfa5","updated_date":"2025-12-07T11:57:32.335777Z","expand":{"roles":null,"allowed_actions":null,"auth_scopes":null,"is_private":null,"expansions":null},"name":"file1.yml","ref_type":"FILE","path":"file1.yml","description":"YML file containing the character \'a\'","metadata":{},"artifact_type":"FILE","generating_flow_id":"a2948c21-703a-4240-9f92-943e0a4803cb"}</flow-result>' +
      '<flow-chat i="1820" t="2025-12-07T11:57:32.458268+00:00" data-type="string"></flow-chat>' +
      '<flow-result i="1821" t="2025-12-07T11:57:32.620523+00:00" data-type="entity">{"type":"artifact","id":"656d58b6-2d0c-4d98-88dd-0048f8c1d166","created_by":"8aebc757-6c62-4311-8ab6-54349f4fdfa5","created_date":"2025-12-07T11:57:32.622701Z","updated_by":"8aebc757-6c62-4311-8ab6-54349f4fdfa5","updated_date":"2025-12-07T11:57:32.622701Z","expand":{"roles":null,"allowed_actions":null,"auth_scopes":null,"is_private":null,"expansions":null},"name":"file2.yml","ref_type":"FILE","path":"file2.yml","description":"YML file containing the character \'b\'","metadata":{},"artifact_type":"FILE","generating_flow_id":"a2948c21-703a-4240-9f92-943e0a4803cb"}</flow-result>' +
      '<flow-chat i="1822" t="2025-12-07T11:57:32.694327+00:00" data-type="string"></flow-chat>' +
      '<flow-result i="1823" t="2025-12-07T11:57:32.860286+00:00" data-type="entity">{"type":"artifact","id":"993b32b1-3577-45b3-b81e-1b7fdbbcdedb","created_by":"8aebc757-6c62-4311-8ab6-54349f4fdfa5","created_date":"2025-12-07T11:57:32.862316Z","updated_by":"8aebc757-6c62-4311-8ab6-54349f4fdfa5","updated_date":"2025-12-07T11:57:32.862316Z","expand":{"roles":null,"allowed_actions":null,"auth_scopes":null,"is_private":null,"expansions":null},"name":"file3.yml","ref_type":"FILE","path":"file3.yml","description":"YML file containing the character \'c\'","metadata":{},"artifact_type":"FILE","generating_flow_id":"a2948c21-703a-4240-9f92-943e0a4803cb"}</flow-result>' +
      '<flow-chat i="1824" t="2025-12-07T11:57:32.942599+00:00" data-type="string"></flow-chat>' +
      '<flow-result i="1825" t="2025-12-07T11:57:33.121073+00:00" data-type="entity">{"type":"artifact","id":"9dae6864-b54a-472c-98f6-1dea97cf4ec3","created_by":"8aebc757-6c62-4311-8ab6-54349f4fdfa5","created_date":"2025-12-07T11:57:33.123234Z","updated_by":"8aebc757-6c62-4311-8ab6-54349f4fdfa5","updated_date":"2025-12-07T11:57:33.123234Z","expand":{"roles":null,"allowed_actions":null,"auth_scopes":null,"is_private":null,"expansions":null},"name":"file4.yml","ref_type":"FILE","path":"file4.yml","description":"YML file containing the character \'d\'","metadata":{},"artifact_type":"FILE","generating_flow_id":"a2948c21-703a-4240-9f92-943e0a4803cb"}</flow-result>' +
      '<flow-chat i="1826" t="2025-12-07T11:57:33.204068+00:00" data-type="string"></flow-chat>' +
      '<flow-result i="1827" t="2025-12-07T11:57:33.414527+00:00" data-type="entity">{"type":"artifact","id":"b5087342-6733-4068-b012-8fdc38ddd457","created_by":"8aebc757-6c62-4311-8ab6-54349f4fdfa5","created_date":"2025-12-07T11:57:33.417591Z","updated_by":"8aebc757-6c62-4311-8ab6-54349f4fdfa5","updated_date":"2025-12-07T11:57:33.417591Z","expand":{"roles":null,"allowed_actions":null,"auth_scopes":null,"is_private":null,"expansions":null},"name":"file5.yml","ref_type":"FILE","path":"file5.yml","description":"YML file containing the character \'e\'","metadata":{},"artifact_type":"FILE","generating_flow_id":"a2948c21-703a-4240-9f92-943e0a4803cb"}</flow-result>' +
      '<flow-chat i="1828" t="2025-12-07T11:57:33.499310+00:00" data-type="string"></flow-chat>' +
      '<flow-result i="1829" t="2025-12-07T11:57:33.631465+00:00" data-type="entity">{"type":"artifact","id":"f44514e8-4266-41b4-bb90-fed488f72e6c","created_by":"8aebc757-6c62-4311-8ab6-54349f4fdfa5","created_date":"2025-12-07T11:57:33.633628Z","updated_by":"8aebc757-6c62-4311-8ab6-54349f4fdfa5","updated_date":"2025-12-07T11:57:33.633628Z","expand":{"roles":null,"allowed_actions":null,"auth_scopes":null,"is_private":null,"expansions":null},"name":"file6.yml","ref_type":"FILE","path":"file6.yml","description":"YML file containing the character \'f\'","metadata":{},"artifact_type":"FILE","generating_flow_id":"a2948c21-703a-4240-9f92-943e0a4803cb"}</flow-result>' +
      '||<flow-checkpoint i="1830" t="2025-12-07T11:57:33.896018+00:00" data-type="string" checkpoint_hash="622a75c7229a74da25aef2fb33b2548695f4f623"></flow-checkpoint>' +
      '<flow-llm-end i="1831" t="2025-12-07T11:57:33.896422+00:00" data-type="string">LLM generation complete</flow-llm-end>';

    flowMock.setMockStreamXML(mockXML);

    // Render chat panel
    render(
      <QueryClientProvider client={queryClient}>
        <SimpleChatPanel flow={flowMock} />
      </QueryClientProvider>,
    );

    // Start streaming
    const _sendPromise = flowMock.sendMessage('test');

    // Track artifact count as it increases during streaming
    const artifactCounts: number[] = [];

    // Monitor artifact count during streaming
    const checkArtifactCount = () => {
      const countElement = screen.queryByTestId('artifact-count');
      if (countElement) {
        const countText = countElement.textContent || '';
        const match = countText.match(/Count: (\d+)/);
        if (match) {
          const count = parseInt(match[1], 10);
          if (artifactCounts.length === 0 || artifactCounts[artifactCounts.length - 1] !== count) {
            artifactCounts.push(count);
          }
        }
      }
    };

    // Wait for streaming to complete
    await waitFor(() => expect(flowMock.executionStatus).toBe('Ready'), { timeout: 5000 });

    // Wait a bit more for React to render all artifacts
    await waitFor(
      () => {
        checkArtifactCount();
        const countElement = screen.getByTestId('artifact-count');
        expect(countElement).toHaveTextContent('Count: 6');
      },
      { timeout: 2000 },
    );

    // Verify all 6 artifacts are rendered
    expect(screen.getByTestId('artifact-0')).toBeInTheDocument();
    expect(screen.getByTestId('artifact-1')).toBeInTheDocument();
    expect(screen.getByTestId('artifact-2')).toBeInTheDocument();
    expect(screen.getByTestId('artifact-3')).toBeInTheDocument();
    expect(screen.getByTestId('artifact-4')).toBeInTheDocument();
    expect(screen.getByTestId('artifact-5')).toBeInTheDocument();

    // Verify artifact paths
    expect(screen.getByTestId('artifact-path-0')).toHaveTextContent('file1.yml');
    expect(screen.getByTestId('artifact-path-1')).toHaveTextContent('file2.yml');
    expect(screen.getByTestId('artifact-path-2')).toHaveTextContent('file3.yml');
    expect(screen.getByTestId('artifact-path-3')).toHaveTextContent('file4.yml');
    expect(screen.getByTestId('artifact-path-4')).toHaveTextContent('file5.yml');
    expect(screen.getByTestId('artifact-path-5')).toHaveTextContent('file6.yml');

    // Verify artifact indices
    expect(screen.getByTestId('artifact-index-0')).toHaveTextContent('Index: 1819');
    expect(screen.getByTestId('artifact-index-1')).toHaveTextContent('Index: 1821');
    expect(screen.getByTestId('artifact-index-2')).toHaveTextContent('Index: 1823');
    expect(screen.getByTestId('artifact-index-3')).toHaveTextContent('Index: 1825');
    expect(screen.getByTestId('artifact-index-4')).toHaveTextContent('Index: 1827');
    expect(screen.getByTestId('artifact-index-5')).toHaveTextContent('Index: 1829');

    // Verify we saw progressive rendering (count increased during streaming)
    // This ensures artifacts appeared during streaming, not just at the end
    expect(artifactCounts.length).toBeGreaterThan(0);
    expect(artifactCounts[artifactCounts.length - 1]).toBe(6);
  });

  it('should render artifacts progressively as they stream in', async () => {
    // XML with breakpoints to test progressive rendering
    // Fix: Add required fields 'type', 'name', 'ref_type', and 'id' (UUID) to artifact JSON
    const mockXML =
      '<flow-result i="1" t="2025-01-01T10:00:00Z" data-type="entity">{"type":"artifact","id":"11111111-1111-4111-8111-111111111111","name":"file1.yml","ref_type":"FILE","path":"file1.yml","artifact_type":"FILE"}</flow-result>' +
      '|| |break| ||' +
      '<flow-result i="2" t="2025-01-01T10:00:01Z" data-type="entity">{"type":"artifact","id":"22222222-2222-4222-8222-222222222222","name":"file2.yml","ref_type":"FILE","path":"file2.yml","artifact_type":"FILE"}</flow-result>' +
      '|| |break| ||' +
      '<flow-result i="3" t="2025-01-01T10:00:02Z" data-type="entity">{"type":"artifact","id":"33333333-3333-4333-8333-333333333333","name":"file3.yml","ref_type":"FILE","path":"file3.yml","artifact_type":"FILE"}</flow-result>';

    flowMock.setMockStreamXML(mockXML);

    // Render chat panel
    render(
      <QueryClientProvider client={queryClient}>
        <SimpleChatPanel flow={flowMock} />
      </QueryClientProvider>,
    );

    // Start streaming
    const _sendPromise = flowMock.sendMessage('test');

    // Wait for first breakpoint
    await waitFor(() => expect(flowMock.isAtBreakpoint()).toBe(true), { timeout: 2000 });

    // Wait for first artifact to render
    await waitFor(
      () => {
        expect(screen.getByTestId('artifact-0')).toBeInTheDocument();
        expect(screen.getByTestId('artifact-path-0')).toHaveTextContent('file1.yml');
      },
      { timeout: 2000 },
    );

    // Verify ONLY first artifact is visible
    expect(screen.queryByTestId('artifact-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('artifact-2')).not.toBeInTheDocument();

    // Continue streaming
    await flowMock.continueStreaming();

    // Wait for second breakpoint
    await waitFor(() => expect(flowMock.isAtBreakpoint()).toBe(true), { timeout: 2000 });

    // Wait for second artifact to render
    await waitFor(
      () => {
        expect(screen.getByTestId('artifact-1')).toBeInTheDocument();
        expect(screen.getByTestId('artifact-path-1')).toHaveTextContent('file2.yml');
      },
      { timeout: 2000 },
    );

    // Verify first AND second artifacts are visible, but NOT third
    expect(screen.getByTestId('artifact-0')).toBeInTheDocument();
    expect(screen.queryByTestId('artifact-2')).not.toBeInTheDocument();

    // Continue streaming to completion
    await flowMock.continueStreaming();

    // Wait for third artifact to render
    await waitFor(
      () => {
        expect(screen.getByTestId('artifact-2')).toBeInTheDocument();
        expect(screen.getByTestId('artifact-path-2')).toHaveTextContent('file3.yml');
      },
      { timeout: 2000 },
    );

    // Verify all three artifacts are now visible
    expect(screen.getByTestId('artifact-0')).toBeInTheDocument();
    expect(screen.getByTestId('artifact-1')).toBeInTheDocument();
    expect(screen.getByTestId('artifact-2')).toBeInTheDocument();
  });
});
