/**
 * NavigationDecision: what was typed in, a dock to navigate OR a prompt for the assistant out —
 * a mirror of `flow_sdk/core/navigation_decision.py` (`navigation.outcome`).
 *
 * It never fails. Anything missing or unsure answers the prompt (the utterance, unchanged), and so
 * does a box with no decision API on the hub, so a caller's only branch is "navigate, or ask".
 */

import apiClient from '../client';

export interface NavigationTarget {
  kind: 'view' | 'entity' | 'file' | 'url' | 'webapp' | 'app' | 'log';
  /** A dock address, a TypeId, a path, a URL, a port or an artifact id — what `kind` says. */
  value: string;
}

/** `navigator.decision`: what was decided. */
export interface NavigationChoice {
  route: 'quick' | 'agentic';
  target?: NavigationTarget | null;
  verb?: 'show' | 'navigate' | null;
  confidence?: number | null;
}

/** `navigation.outcome`: `address` (+ `dock`) to navigate, OR `prompt` to ask — never both. A file,
 * URL or web-app target sets neither: the caller builds that dock from `decision.target`. */
export interface NavigationOutcome {
  decision: NavigationChoice;
  candidates: { typeid?: string; type: string; title?: string; path?: string }[];
  dock?: { viewType: string; pointer: string };
  address?: string;
  prompt?: string;
}

/**
 * `here` (a `navigation.here`) defaults to where the active tab is: the backend reads that tab's
 * own browser context, so a caller in the UI sends only what was typed.
 */
export async function navigationDecision(
  utterance: string,
  options: { here?: Record<string, unknown> } = {},
): Promise<NavigationOutcome> {
  const asked: NavigationOutcome = { decision: { route: 'agentic' }, candidates: [], prompt: utterance };
  try {
    const outcome = await apiClient.post<NavigationOutcome>('/api/v1/graph/compute_node/@local/navigation-decision', {
      utterance,
      ...(options.here ? { here: options.here } : {}),
    });
    return outcome ?? asked;
  } catch {
    return asked; // a box that cannot answer is a box that asks as today
  }
}
