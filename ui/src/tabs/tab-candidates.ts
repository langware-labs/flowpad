/**
 * Adapter between the terminal strip (`TerminalTab`) and the pure resolver
 * (`TabCandidate`). Kept separate from the SDK-pure `tab-model.ts` because it
 * depends on the strip's `TerminalTab` shape.
 */
import { type TerminalTab, terminalTargetKey } from '@src/hooks/useActiveTerminals';
import { type TabCandidate } from './tab-model';

/** Epoch ms of a session's last activation (recency seed), or null.
 *  Prefers the AgenticProcess (the tab's identity entity) over its transport shell. */
export function sessionLastActiveMs(session: TerminalTab): number | null {
  const raw = session.agenticProcess?.last_active_at ?? session.shell?.last_active_at;
  // Wire is epoch-ms (base-Entity field, Part 3 §4); legacy rows may still
  // deliver an ISO string during the transition window. Tolerate both.
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : t;
}

/** Map the strip's sessions to resolver candidates. The candidate `key` is the
 *  canonical `terminalTargetKey` — the SAME key format a footer-chip click pins
 *  as its pending intent (`agentic_process-<id>`), which is what lets
 *  `resolveActive` case 2 match a cross-project chip click (Bug 2). */
export function buildTabCandidates(sessions: TerminalTab[]): TabCandidate[] {
  return sessions.map((s) => ({
    key: terminalTargetKey(s),
    lastActiveAt: sessionLastActiveMs(s),
    tabOrder: s.tabOrder,
  }));
}
