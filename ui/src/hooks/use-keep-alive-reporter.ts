import { ActionInfo, dataContext, dataManager, RuntimeKind } from '@sdk';
import { useEffect } from 'react';

/** Half the backend's one-minute window, so continuous use never falls between two ticks. */
const REPORT_EVERY_MS = 30_000;

const INPUT_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

/**
 * Tell the backend a person is using this UI, so a hub sandbox stays awake while they do.
 *
 * Only on a hub-launched box (`sandbox` / `agent`): anywhere else there is no idle clock
 * to hold open. Driven by INPUT, not by focus or an open tab — a tab nobody touches is
 * exactly the machine that should pause. Reported as the `keep-alive` action on this
 * instance's ComputeNode; the backend's keep-alive loop turns these reports into the
 * once-a-minute keep-alive to the hub (flow_sdk/compute/keep_alive.py).
 *
 * Mount exactly once at the app root.
 */
export function useKeepAliveReporter(): void {
  useEffect(() => {
    let lastSent = 0;

    const onInput = () => {
      const kind = dataContext.runtimeKind;
      if (kind !== RuntimeKind.SANDBOX && kind !== RuntimeKind.AGENT) return;
      const computeNode = dataContext.computeNode;
      if (!computeNode) return;
      const now = Date.now();
      if (now - lastSent < REPORT_EVERY_MS) return;
      lastSent = now;
      // Fire-and-forget: a missed report costs at most one idle window, and the
      // next input retries.
      const action = new ActionInfo('keep-alive', 'compute_node', computeNode.id, 'POST');
      void dataManager.callAction(action).catch(() => {});
    };

    for (const name of INPUT_EVENTS) {
      window.addEventListener(name, onInput, { capture: true, passive: true });
    }
    return () => {
      for (const name of INPUT_EVENTS) {
        window.removeEventListener(name, onInput, { capture: true });
      }
    };
  }, []);
}
