/**
 * Chat Panel Components Unit Tests
 *
 * Tests each part of the chat-panel.tsx implementation separately:
 * - subscribe function
 * - getSnapshot function
 * - useSyncExternalStore integration
 * - currentConversationResults logic
 * - etc.
 */

import { Flow, FlowData, FlowElementTypes, FlowEvents } from '@sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useProcessStreamingArtifacts } from '@src/hooks/flow-hooks';
import { render, screen, waitFor } from '@testing-library/react';
import React, { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgenticProcessMock as FlowMock } from '../../utils/stub/agentic_process_mock';
import { unitTestSetup } from '../../utils/test-utils';

describe('Chat Panel - Component Parts', () => {
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
    flowMock.streamChunkDelay = 10;
  });

  describe('subscribe function', () => {
    it('should subscribe to both DATA and DATA_END events', () => {
      const callbacks: (() => void)[] = [];
      const subscribe = (callback: () => void) => {
        callbacks.push(callback);
        const handler = () => callback();
        flowMock.on(FlowEvents.DATA, handler);
        flowMock.on(FlowEvents.DATA_END, handler);
        return () => {
          flowMock.off(FlowEvents.DATA, handler);
          flowMock.off(FlowEvents.DATA_END, handler);
        };
      };

      const callback1 = vi.fn();
      const callback2 = vi.fn();

      const unsubscribe1 = subscribe(callback1);
      const unsubscribe2 = subscribe(callback2);

      // Emit DATA event
      flowMock.emit(FlowEvents.DATA, {} as FlowData);
      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledTimes(1);

      // Emit DATA_END event
      flowMock.emit(FlowEvents.DATA_END, {} as FlowData);
      expect(callback1).toHaveBeenCalledTimes(2);
      expect(callback2).toHaveBeenCalledTimes(2);

      // Unsubscribe first callback
      unsubscribe1();
      flowMock.emit(FlowEvents.DATA, {} as FlowData);
      expect(callback1).toHaveBeenCalledTimes(2); // No longer called
      expect(callback2).toHaveBeenCalledTimes(3); // Still called

      unsubscribe2();
    });
  });

  describe('getSnapshot function', () => {
    it('should detect when array length changes', async () => {
      function TestComponent({ flow }: { flow: Flow }) {
        const snapshotRef = useRef<readonly FlowData[]>([]);
        const dataRefsRef = useRef<Map<FlowData, any>>(new Map());

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
          const lengthChanged = currentItems.length !== snapshotRef.current.length;
          const itemsChanged = currentItems.some((item, i) => item !== snapshotRef.current[i]);
          const contentChanged = currentItems.some((item, i) => {
            const oldItem = snapshotRef.current[i];
            if (item !== oldItem) return true;
            if (!oldItem) return false;
            const oldDataRef = dataRefsRef.current.get(oldItem);
            const newDataRef = item.data;
            if (oldDataRef !== newDataRef) {
              dataRefsRef.current.set(item, newDataRef);
              return true;
            }
            return false;
          });

          if (lengthChanged || itemsChanged || contentChanged) {
            snapshotRef.current = [...currentItems];
            dataRefsRef.current.clear();
            currentItems.forEach((item) => {
              dataRefsRef.current.set(item, item.data);
            });
          }

          return snapshotRef.current;
        }, [flow]);

        const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

        return (
          <div data-testid="test-component">
            <div data-testid="snapshot-length">Length: {snapshot.length}</div>
          </div>
        );
      }

      const mockXML = '<flow-chat i="1" t="2025-01-01T10:00:00Z" data-type="string">Hello</flow-chat>';
      flowMock.setMockStreamXML(mockXML);

      render(
        <QueryClientProvider client={queryClient}>
          <TestComponent flow={flowMock} />
        </QueryClientProvider>,
      );

      await flowMock.sendMessage('test');
      await waitFor(() => expect(flowMock.executionStatus).toBe('Ready'), { timeout: 2000 });

      // After streaming, should have items
      await waitFor(
        () => {
          const lengthElement = screen.getByTestId('snapshot-length');
          const length = parseInt(lengthElement.textContent?.replace('Length: ', '') || '0');
          expect(length).toBeGreaterThan(0);
        },
        { timeout: 2000 },
      );
    });

    it('should detect when FlowData.data property changes', async () => {
      function TestComponent({ flow }: { flow: Flow }) {
        const snapshotRef = useRef<readonly FlowData[]>([]);
        const dataRefsRef = useRef<Map<FlowData, any>>(new Map());

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
          const lengthChanged = currentItems.length !== snapshotRef.current.length;
          const itemsChanged = currentItems.some((item, i) => item !== snapshotRef.current[i]);
          const contentChanged = currentItems.some((item, i) => {
            const oldItem = snapshotRef.current[i];
            if (item !== oldItem) return true;
            if (!oldItem) return false;
            const oldDataRef = dataRefsRef.current.get(oldItem);
            const newDataRef = item.data;
            if (oldDataRef !== newDataRef) {
              dataRefsRef.current.set(item, newDataRef);
              return true;
            }
            return false;
          });

          if (lengthChanged || itemsChanged || contentChanged) {
            snapshotRef.current = [...currentItems];
            dataRefsRef.current.clear();
            currentItems.forEach((item) => {
              dataRefsRef.current.set(item, item.data);
            });
          }

          return snapshotRef.current;
        }, [flow]);

        const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
        const resultItems = snapshot.filter((item) => item.elementType === FlowElementTypes.RESULT);

        return (
          <div data-testid="test-component">
            <div data-testid="result-count">Results: {resultItems.length}</div>
            {resultItems.map((item, i) => (
              <div key={i} data-testid={`result-${i}`}>
                {item.data?.path ? `Has data: ${item.data.path}` : 'No data'}
              </div>
            ))}
          </div>
        );
      }

      // Fix: Add required fields 'name' and 'ref_type' to artifact JSON, use UUID for ID
      const mockXML =
        '<flow-result i="1" t="2025-01-01T10:00:00Z" data-type="entity">{"type":"artifact","id":"11111111-1111-4111-8111-111111111111","name":"test.yml","ref_type":"FILE","path":"test.yml","artifact_type":"FILE"}</flow-result>';

      flowMock.setMockStreamXML(mockXML);

      render(
        <QueryClientProvider client={queryClient}>
          <TestComponent flow={flowMock} />
        </QueryClientProvider>,
      );

      await flowMock.sendMessage('test');
      await waitFor(() => expect(flowMock.executionStatus).toBe('Ready'), { timeout: 2000 });

      await waitFor(
        () => {
          const resultCount = screen.getByTestId('result-count');
          expect(resultCount).toHaveTextContent('Results: 1');
        },
        { timeout: 2000 },
      );

      // Check if data was populated
      const resultElement = screen.getByTestId('result-0');
      expect(resultElement.textContent).toContain('Has data: test.yml');
    });
  });

  describe('useSyncExternalStore integration', () => {
    it('should update when subscribe callback is triggered', async () => {
      function TestComponent({ flow }: { flow: Flow }) {
        const snapshotRef = useRef<readonly FlowData[]>([]);
        const dataRefsRef = useRef<Map<FlowData, any>>(new Map());

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
          const lengthChanged = currentItems.length !== snapshotRef.current.length;
          const itemsChanged = currentItems.some((item, i) => item !== snapshotRef.current[i]);
          const contentChanged = currentItems.some((item, i) => {
            const oldItem = snapshotRef.current[i];
            if (item !== oldItem) return true;
            if (!oldItem) return false;
            const oldDataRef = dataRefsRef.current.get(oldItem);
            const newDataRef = item.data;
            if (oldDataRef !== newDataRef) {
              dataRefsRef.current.set(item, newDataRef);
              return true;
            }
            return false;
          });

          if (lengthChanged || itemsChanged || contentChanged) {
            snapshotRef.current = [...currentItems];
            dataRefsRef.current.clear();
            currentItems.forEach((item) => {
              dataRefsRef.current.set(item, item.data);
            });
          }

          return snapshotRef.current;
        }, [flow]);

        const chat = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
        const resultItems = chat.filter((item) => item.elementType === FlowElementTypes.RESULT);

        return (
          <div data-testid="test-component">
            <div data-testid="total-count">Total: {chat.length}</div>
            <div data-testid="result-count">Results: {resultItems.length}</div>
            {resultItems.map((item, i) => (
              <div key={i} data-testid={`result-${i}`}>
                {item.data?.path || 'no-path'}
              </div>
            ))}
          </div>
        );
      }

      // Fix: Add required fields and UUIDs
      const mockXML =
        '<flow-result i="1" t="2025-01-01T10:00:00Z" data-type="entity">{"type":"artifact","id":"11111111-1111-4111-8111-111111111111","name":"file1.yml","ref_type":"FILE","path":"file1.yml","artifact_type":"FILE"}</flow-result>' +
        '||<flow-result i="2" t="2025-01-01T10:00:01Z" data-type="entity">{"type":"artifact","id":"22222222-2222-4222-8222-222222222222","name":"file2.yml","ref_type":"FILE","path":"file2.yml","artifact_type":"FILE"}</flow-result>';

      flowMock.setMockStreamXML(mockXML);

      render(
        <QueryClientProvider client={queryClient}>
          <TestComponent flow={flowMock} />
        </QueryClientProvider>,
      );

      await flowMock.sendMessage('test');
      await waitFor(() => expect(flowMock.executionStatus).toBe('Ready'), { timeout: 2000 });

      // Wait for React to update
      await waitFor(
        () => {
          const resultCount = screen.getByTestId('result-count');
          expect(resultCount).toHaveTextContent('Results: 2');
        },
        { timeout: 2000 },
      );

      expect(screen.getByTestId('result-0')).toHaveTextContent('file1.yml');
      expect(screen.getByTestId('result-1')).toHaveTextContent('file2.yml');
    });
  });

  describe('currentConversationResults logic', () => {
    it('should filter results after the last user message', () => {
      function TestComponent({ flow }: { flow: Flow }) {
        const snapshotRef = useRef<readonly FlowData[]>([]);
        const dataRefsRef = useRef<Map<FlowData, any>>(new Map());

        const subscribe = useCallback(
          (callback: () => void) => {
            const handler = () => callback();
            // Subscribe to both flow and flow.stream events to ensure synchronization
            // with useProcessStream (used by useProcessStreamingArtifacts)
            flow.on(FlowEvents.DATA, handler);
            flow.on(FlowEvents.DATA_END, handler);
            flow.stream.on(FlowEvents.DATA, handler);
            flow.stream.on(FlowEvents.RENDER, handler);
            return () => {
              flow.off(FlowEvents.DATA, handler);
              flow.off(FlowEvents.DATA_END, handler);
              flow.stream.off(FlowEvents.DATA, handler);
              flow.stream.off(FlowEvents.RENDER, handler);
            };
          },
          [flow],
        );

        const getSnapshot = useCallback(() => {
          const currentItems = flow.stream.items || [];
          const lengthChanged = currentItems.length !== snapshotRef.current.length;
          const itemsChanged = currentItems.some((item, i) => item !== snapshotRef.current[i]);
          const contentChanged = currentItems.some((item, i) => {
            const oldItem = snapshotRef.current[i];
            if (item !== oldItem) return true;
            if (!oldItem) return false;
            const oldDataRef = dataRefsRef.current.get(oldItem);
            const newDataRef = item.data;
            if (oldDataRef !== newDataRef) {
              dataRefsRef.current.set(item, newDataRef);
              return true;
            }
            return false;
          });

          if (lengthChanged || itemsChanged || contentChanged) {
            snapshotRef.current = [...currentItems];
            dataRefsRef.current.clear();
            currentItems.forEach((item) => {
              dataRefsRef.current.set(item, item.data);
            });
          }

          return snapshotRef.current;
        }, [flow]);

        const chat = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

        // Use the real useProcessStreamingArtifacts hook (matches real implementation)
        const { getStreamingFlowDataAfter } = useProcessStreamingArtifacts(flow);

        // Simulate currentConversationResults logic (matches real implementation)
        // Also depend on flow.stream.items.length to trigger re-computation when useProcessStream updates
        // This ensures getStreamingFlowDataAfter has the latest data from useProcessStream
        const streamItemsLength = flow.stream.items.length;
        const currentConversationResults = useMemo(() => {
          if (!chat || chat.length === 0) return [];

          // Find the index of the last user message (from reversed array)
          const reversedIndex = [...chat]
            .reverse()
            .findIndex(
              (flowData) =>
                flowData.elementType === FlowElementTypes.USER_MESSAGE || flowData.attributes.role === 'user',
            );

          if (reversedIndex === -1) return [];

          // Convert reversed index back to original array index
          const lastUserMessageIndex = chat.length - 1 - reversedIndex;
          const lastUserMessageTimestamp =
            typeof chat[lastUserMessageIndex].timestamp === 'string'
              ? new Date(chat[lastUserMessageIndex].timestamp).getTime()
              : chat[lastUserMessageIndex].timestamp;

          // Use the callback to get FlowData items after the last user message
          return getStreamingFlowDataAfter(lastUserMessageTimestamp);
        }, [chat, getStreamingFlowDataAfter, streamItemsLength]);

        return (
          <div data-testid="test-component">
            <div data-testid="conversation-results-count">
              Conversation Results: {currentConversationResults.length}
            </div>
            {currentConversationResults.map((item, i) => (
              <div key={i} data-testid={`conversation-result-${i}`}>
                {item.data?.path || 'no-path'}
              </div>
            ))}
          </div>
        );
      }

      // Fix: Don't include user-message in XML - sendMessage() creates one automatically
      // Use timestamps that are definitely after the user message timestamp
      // We'll set the mock XML after render but before sendMessage to ensure timestamps are after user message
      render(
        <QueryClientProvider client={queryClient}>
          <TestComponent flow={flowMock} />
        </QueryClientProvider>,
      );

      // Set mock XML with timestamps that are definitely in the future relative to now
      // This ensures results come after the user message timestamp
      const baseTime = Date.now();
      const result1Time = new Date(baseTime + 1000).toISOString(); // 1 second after base
      const result2Time = new Date(baseTime + 2000).toISOString(); // 2 seconds after base
      const mockXML =
        `<flow-result i="2" t="${result1Time}" data-type="entity">{"type":"artifact","id":"11111111-1111-4111-8111-111111111111","name":"file1.yml","ref_type":"FILE","path":"file1.yml","artifact_type":"FILE"}</flow-result>` +
        `||<flow-result i="3" t="${result2Time}" data-type="entity">{"type":"artifact","id":"22222222-2222-4222-8222-222222222222","name":"file2.yml","ref_type":"FILE","path":"file2.yml","artifact_type":"FILE"}</flow-result>`;
      flowMock.setMockStreamXML(mockXML);

      return flowMock.sendMessage('test').then(async () => {
        await waitFor(() => expect(flowMock.executionStatus).toBe('Ready'), { timeout: 2000 });

        // Wait for flow.stream.items to be populated (used by useProcessStream in useProcessStreamingArtifacts)
        // This ensures useProcessStream has updated before we check the results
        await waitFor(
          () => {
            const resultItems = flowMock.stream.items.filter((item) => item.elementType === FlowElementTypes.RESULT);
            expect(resultItems.length).toBeGreaterThanOrEqual(2);
          },
          { timeout: 2000 },
        );

        await waitFor(
          () => {
            const count = screen.getByTestId('conversation-results-count');
            expect(count).toHaveTextContent('Conversation Results: 2');
          },
          { timeout: 2000 },
        );
      });
    });
  });

  describe('chatFlowData filtering logic', () => {
    it('should filter and order FlowData correctly', () => {
      function TestComponent({ flow }: { flow: Flow }) {
        const snapshotRef = useRef<readonly FlowData[]>([]);
        const dataRefsRef = useRef<Map<FlowData, any>>(new Map());

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
          const lengthChanged = currentItems.length !== snapshotRef.current.length;
          const itemsChanged = currentItems.some((item, i) => item !== snapshotRef.current[i]);
          const contentChanged = currentItems.some((item, i) => {
            const oldItem = snapshotRef.current[i];
            if (item !== oldItem) return true;
            if (!oldItem) return false;
            const oldDataRef = dataRefsRef.current.get(oldItem);
            const newDataRef = item.data;
            if (oldDataRef !== newDataRef) {
              dataRefsRef.current.set(item, newDataRef);
              return true;
            }
            return false;
          });

          if (lengthChanged || itemsChanged || contentChanged) {
            snapshotRef.current = [...currentItems];
            dataRefsRef.current.clear();
            currentItems.forEach((item) => {
              dataRefsRef.current.set(item, item.data);
            });
          }

          return snapshotRef.current;
        }, [flow]);

        const chat = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

        // Simulate shouldRenderFlowData logic
        const shouldRenderFlowData = (flowData: FlowData): boolean => {
          const messageTypes: string[] = [
            FlowElementTypes.USER_MESSAGE,
            FlowElementTypes.CHAT,
            FlowElementTypes.TEXT,
            FlowElementTypes.REASONING,
            FlowElementTypes.ENV_VAR,
            FlowElementTypes.SHELL,
            FlowElementTypes.SHELL_INPUT,
            FlowElementTypes.SHELL_OUTPUT,
            FlowElementTypes.RESULT,
            FlowElementTypes.CHECKPOINT,
            FlowElementTypes.ERROR,
          ];
          return messageTypes.includes(flowData.elementType);
        };

        // Simulate chatFlowData filtering
        const chatFlowData = useMemo(() => {
          const result: FlowData[] = [];
          const pendingEnvVars: FlowData[] = [];

          for (let i = 0; i < chat.length; i++) {
            const flowData = chat[i];
            if (!shouldRenderFlowData(flowData)) continue;

            if (flowData.elementType === FlowElementTypes.ENV_VAR) {
              pendingEnvVars.push(flowData);
            } else if (flowData.elementType === FlowElementTypes.USER_MESSAGE && pendingEnvVars.length > 0) {
              result.push(...pendingEnvVars);
              pendingEnvVars.length = 0;
              result.push(flowData);
            } else {
              result.push(flowData);
            }
          }

          if (pendingEnvVars.length > 0) {
            result.push(...pendingEnvVars);
          }

          return result;
        }, [chat]);

        const resultItems = chatFlowData.filter((item) => item.elementType === FlowElementTypes.RESULT);

        return (
          <div data-testid="test-component">
            <div data-testid="chat-flow-data-count">ChatFlowData: {chatFlowData.length}</div>
            <div data-testid="result-items-count">Result Items: {resultItems.length}</div>
            {resultItems.map((item, i) => (
              <div key={i} data-testid={`filtered-result-${i}`}>
                {item.data?.path || 'no-path'}
              </div>
            ))}
          </div>
        );
      }

      const mockXML =
        '<flow-chat i="1" t="2025-01-01T10:00:00Z" data-type="string">Hello</flow-chat>' +
        '||<flow-result i="2" t="2025-01-01T10:00:01Z" data-type="entity">{"type":"artifact","path":"file1.yml","artifact_type":"FILE"}</flow-result>' +
        '||<flow-status i="3" t="2025-01-01T10:00:02Z" data-type="string">Status</flow-status>' +
        '||<flow-result i="4" t="2025-01-01T10:00:03Z" data-type="entity">{"type":"artifact","path":"file2.yml","artifact_type":"FILE"}</flow-result>';

      flowMock.setMockStreamXML(mockXML);

      render(
        <QueryClientProvider client={queryClient}>
          <TestComponent flow={flowMock} />
        </QueryClientProvider>,
      );

      return flowMock.sendMessage('test').then(async () => {
        await waitFor(() => expect(flowMock.executionStatus).toBe('Ready'), { timeout: 2000 });

        await waitFor(
          () => {
            const resultCount = screen.getByTestId('result-items-count');
            expect(resultCount).toHaveTextContent('Result Items: 2');
          },
          { timeout: 2000 },
        );

        // STATUS should be filtered out (not in shouldRenderFlowData)
        // sendMessage() creates a USER_MESSAGE automatically, so we have: USER_MESSAGE + CHAT + 2 RESULTS = 4 items
        const chatFlowDataCount = screen.getByTestId('chat-flow-data-count');
        expect(chatFlowDataCount).toHaveTextContent('ChatFlowData: 4'); // USER_MESSAGE + CHAT + 2 RESULTS (STATUS filtered out)
      });
    });
  });
});
