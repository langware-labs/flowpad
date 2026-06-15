import { AgenticProcess, CodeRef, Flow, FlowData, FlowElementTypes, ViewType } from '@sdk';
import { useCallback, useEffect, useRef } from 'react';
import { useDockNavigation } from '../../navigation/useDockNavigation';
import { useProcessExecution } from './useProcessExecution';
import { useProcessStream } from './useProcessStream';
import { useViewerStore } from './useViewerStore';

/**
 * Hook that synchronizes flow focus requests with the viewer store
 *
 * This hook:
 * 1. Reacts to flow focus elements in stream
 * 2. Automatically updates overview tab when agent requests focus change
 * 3. Automatically updates active tab and current context when url dock changes
 * 4. Automatically focuses on the last artifact when streaming completes
 *
 * @param flow - The flow entity to track
 */
export function useActiveViewer(flow: Flow | AgenticProcess | null | undefined) {
  const { currentOverviewTab, setCurrentOverviewTab, setCurrentContext } = useViewerStore();
  const { navigation, currentDock, isDockUrl } = useDockNavigation();

  // Use ref to track current flow and prevent unnecessary re-subscriptions
  const flowRef = useRef<Flow | AgenticProcess | null | undefined>(flow);
  const processIdRef = useRef<string | undefined>(flow?.id);

  // useProcessStream / useProcessExecution only work with the legacy Flow entity.
  // Pass null for AgenticProcess — URL-driven navigation still works without streaming.
  const legacyFlow = flow instanceof AgenticProcess ? null : (flow as Flow | null | undefined) ?? null;
  const { data: streamData } = useProcessStream(legacyFlow);
  const { isRunning } = useProcessExecution(legacyFlow);

  // Update refs when flow changes
  useEffect(() => {
    flowRef.current = flow;
    processIdRef.current = flow?.id;
  }, [flow]);

  // Callback to apply focus from FlowData to viewer store
  const setCurrentOverviewTabFocusOn = useCallback(
    (flowData: FlowData) => {
      if (!flowData || flowData.focus === null) return;

      const viewType = flowData.focus;
      if (viewType !== currentOverviewTab) {
        setCurrentOverviewTab(viewType);
      }

      // Extract path from focus element data and set context
      const path = flowData.data?.path || flowData.attributes.path;

      setCurrentContext({
        codeRef: path ? new CodeRef({ path }) : undefined,
        viewerType: viewType,
        viewerOptions: {
          port: flowData.data?.metadata?.port,
        },
      });
    },
    [currentOverviewTab, setCurrentOverviewTab, setCurrentContext],
  );

  // Sync flow focus elements from stream to viewer store (agent-driven focus)
  useEffect(() => {
    if (!streamData || streamData.length === 0) return;

    // Find the most recent element with focus attribute in the stream
    const flowDataWithFocus = [...streamData].filter((flowData) => flowData.focus).reverse();
    if (flowDataWithFocus.length === 0) return;

    let flowDataToFocusOn = null;
    if (isRunning) {
      // The most recent element with focus attribute
      flowDataToFocusOn = flowDataWithFocus[0];
    } else {
      // The most recent artifact in the stream
      flowDataToFocusOn = flowDataWithFocus.find((flowData) => flowData.elementType === FlowElementTypes.RESULT);
    }
    if (!flowDataToFocusOn) return;

    // Apply focus
    setCurrentOverviewTabFocusOn(flowDataToFocusOn);
  }, [streamData, setCurrentOverviewTabFocusOn, navigation, isRunning]);

  // Sync URL dock state to viewer store (URL-first architecture)
  useEffect(() => {
    // If URL has no dock, clear the viewing context but KEEP the last
    // overview tab — hard-nulling it here (the old `:92` behavior) blanked
    // the overview panel on every dock-less URL. The overview axis resolves
    // from what's already in the store (tab-management.md Part 3 U1).
    if (!isDockUrl || !currentDock) {
      setCurrentContext(null);
      return;
    }

    // Sync dock pointer to currentContext (for editor files, diff, etc.)
    if (currentDock.pointer || currentDock.options) {
      let viewerOptions = currentDock.options ?? {};
      switch (currentDock.viewType) {
        case ViewType.WEB_APP:
          if (currentDock.options?.port) {
            viewerOptions = { ...viewerOptions, port: currentDock.options?.port };
          }
          break;
        case ViewType.DIFF:
          if (currentDock.pointer) {
            viewerOptions = { ...viewerOptions, checkpointHash: currentDock.pointer };
          }
          break;
        case ViewType.EDITOR:
          break;
        case ViewType.EXPLORER:
          // Explorer uses pointer as path (file or folder)
          // The ExplorerView component will handle resolving file vs folder
          break;
        default:
          break;
      }

      setCurrentContext({
        codeRef: currentDock.pointer ? new CodeRef({ path: currentDock.pointer }) : undefined,
        viewerType: currentDock.viewType,
        viewerOptions,
      });
    } else {
      // Dock with no pointer or options (like plain tab views) - clear context
      setCurrentContext(null);
    }

    // The header-chip feeding (addTab/setActiveTab) that used to live here is
    // gone — the unified TabStrip replaced the viewer tab header (Part 3 U1);
    // the content panel derives its current tab from the URL directly.
    // Handle other dock types (fs, etc.) here in the future
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentDock, isDockUrl, setCurrentContext, setCurrentOverviewTab]); // URL drives state, not vice versa.
}
