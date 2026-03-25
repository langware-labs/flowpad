import { Flow, ICompletionOptions } from '@sdk';
import { useCallback, useMemo, useRef } from 'react';

/**
 * Hook providing flow control actions
 * Returns action handlers for flow operations
 *
 * Uses a ref to always access the latest flow value, avoiding stale closure
 * issues when flow changes between callback creation and execution.
 */
export function useProcessActions(flow: Flow | null) {
  const flowRef = useRef(flow);
  flowRef.current = flow;

  const cancel = useCallback(async () => {
    if (!flowRef.current) return;
    return flowRef.current.cancel();
  }, []);

  const save = useCallback(() => {
    if (!flowRef.current) return;
    void flowRef.current.save();
  }, []);

  const send = useCallback(async (message: string, options?: Partial<ICompletionOptions>) => {
    if (!flowRef.current) return;

    // User message is now added in flow.sendMessage() directly
    const result = await flowRef.current.sendMessage(message, {
      ...options,
      processId: flowRef.current.id,
      flowMode: options?.flowMode || 'Agent',
    } as ICompletionOptions);
    return result;
  }, []);

  const clear = useCallback(() => {
    if (!flowRef.current) return;
    void flowRef.current.clear();
  }, []);

  const resume = useCallback(async () => {
    if (!flowRef.current) return;
    return flowRef.current.resume();
  }, []);

  const isReady = useMemo(() => !!flow, [flow]);

  return { cancel, save, send, clear, resume, isReady };
}
