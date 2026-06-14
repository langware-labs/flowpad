/**
 * Adapter between the terminal strip (`TerminalTab`) and the pure resolver
 * (`TabCandidate`). Kept separate from the SDK-pure `tab-model.ts` because it
 * depends on the strip's `TerminalTab` shape.
 */
import {
  type TerminalTab,
  terminalProcessId,
  terminalTargetKey,
  terminalTransportShellId,
} from '@src/tabs/useTabs';
import { resolveActive, type TabCandidate } from './tab-model';
import { consumePendingIntent, peekPendingIntent } from './pending-intent';

/** Epoch ms of a session's last activation (recency seed), or null.
 *  Prefers the backing `Tab` row's `last_active_at` (server-stamped by the
 *  generic `activate` action on every navigation), falling back to the entity. */
export function sessionLastActiveMs(session: TerminalTab): number | null {
  const raw = session.lastActiveAt ?? session.agenticProcess?.last_active_at ?? session.shell?.last_active_at;
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

/**
 * Loader-side default-tab pick — the single `resolveActive` resolver applied
 * to a pre-filtered TerminalTab list (docs/tab-management.md Part 1 §5,
 * Phase 3: retires `resolveDefaultTab`).
 *
 * Eligibility (filtered BEFORE resolving, preserving the old exclusions):
 * not disabled, and none of the tab's ids — target TypeId string, target id,
 * transport shell id, owning-process id — is in `excludeIds`. `excludeIds`
 * is one set because process ids and shell ids are both UUIDs and don't
 * collide.
 *
 * Precedence is `resolveActive`'s (intent → recency → tabOrder; `urlActiveKey`
 * is null — loaders only run this when the URL has no concrete target). The
 * old explicit previous-target / previous-shell tiers
 * (`dataContext.activeTerminalTargetTypeId` / `activeShellId`) are gone
 * INTENTIONALLY: every loader load stamps the entity via `bumpLastActive` +
 * server-side `activate`, so the previously-active tab is exactly the
 * recency-tier winner — one resolver, one rule. A pending intent that decided
 * the pick is consumed.
 */
export function resolveNextTab(
  tabs: TerminalTab[],
  excludeIds: Set<string> = new Set(),
): TerminalTab | null {
  const isPickable = (tab: TerminalTab) => {
    if (tab.isDisabled) return false;
    if (excludeIds.has(tab.targetTypeId.toString())) return false;
    if (excludeIds.has(tab.targetTypeId.id)) return false;
    const shellId = terminalTransportShellId(tab);
    if (shellId && excludeIds.has(shellId)) return false;
    const processId = terminalProcessId(tab);
    if (processId && excludeIds.has(processId)) return false;
    return true;
  };
  const eligible = tabs.filter(isPickable);
  const { activeKey, consumedPendingIntent } = resolveActive({
    candidates: buildTabCandidates(eligible),
    urlActiveKey: null,
    pendingIntentKey: peekPendingIntent(),
  });
  if (consumedPendingIntent) consumePendingIntent();
  if (!activeKey) return null;
  return eligible.find((t) => terminalTargetKey(t) === activeKey) ?? null;
}
