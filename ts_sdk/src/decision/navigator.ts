/**
 * Route a typed request: open something now, or hand it to the assistant — a mirror of
 * `flow_sdk/core/navigator.py` (`navigator.route` / `navigator.target`).
 *
 * It never fails. Anything missing or unsure answers `route: 'agentic'`, and so does a box
 * with no decision API on the hub, so a caller's only branch is "open it, or ask as today".
 */

import apiClient from '../client';

export interface NavigationTarget {
  kind: 'view' | 'entity' | 'file' | 'url' | 'webapp' | 'app';
  /** A dock address, a TypeId, a path, a URL, a port or an artifact id — what `kind` says. */
  value: string;
}

export interface NavigatorRoute {
  route: 'quick' | 'agentic';
  target: NavigationTarget | null;
  verb: 'show' | 'navigate';
  confidence: number;
  /** `rule` / `decision`, or why it fell back (`no_endpoint`, `unsure`, `agentic`, a failure reason). */
  reason: string;
  latency_ms: number;
}

const AGENTIC: NavigatorRoute = {
  route: 'agentic',
  target: null,
  verb: 'show',
  confidence: 0,
  reason: 'unreachable',
  latency_ms: 0,
};

/**
 * `here` (a `navigation.here`) defaults to where the active tab is: the backend reads that tab's
 * own browser context, so a caller in the UI sends only what was typed.
 */
export async function navigatorRoute(
  utterance: string,
  options: { here?: Record<string, unknown> } = {},
): Promise<NavigatorRoute> {
  try {
    const answer = await apiClient.post<NavigatorRoute>('/api/v1/graph/compute_node/@local/navigator-route', {
      utterance,
      ...(options.here ? { here: options.here } : {}),
    });
    return answer ?? AGENTIC;
  } catch {
    return AGENTIC; // a box that cannot answer is a box that asks as today
  }
}
