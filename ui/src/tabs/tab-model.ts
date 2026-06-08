/**
 * Pure tab-resolution model (no React, no navigation, no SDK).
 *
 * `resolveActive` is the SINGLE precedence function that decides which tab a
 * surface should make active. It replaces the scattered per-component fallbacks
 * (`TabbedTerminal`'s index-0 self-heal, `resolveDefaultTab`'s prev-target
 * preference) with one testable rule. It is URL-FIRST: it only RESOLVES a key;
 * the caller maps that key to a DockPointer and navigates. It never writes
 * "active" state the UI reads to highlight.
 *
 * Precedence:
 *   1. url    — the URL's explicit dock target, if it is a live member → wins,
 *               no navigation needed (the URL is already correct).
 *   2. intent — an explicit pending intent (e.g. a footer-chip click), if it is
 *               a live member → wins, and is consumed.            [fixes Bug 2]
 *   3. recency— the member with the greatest `lastActiveAt`.       [fixes Bug 1]
 *   4. order  — the member with the lowest `tabOrder` (replaces `visibleSessions[0]`).
 *   5. none   — no members.
 */

export interface TabCandidate {
  /** Stable membership key (e.g. `terminalTargetKey` / a TypeId string). */
  key: string;
  /** Epoch ms of the tab's last activation; null if never/unknown. Resolver seed only. */
  lastActiveAt: number | null;
  /** Ordering among members. */
  tabOrder: number;
}

export type ResolveSource = 'url' | 'intent' | 'recency' | 'order' | 'none';

export interface ResolveActiveInput {
  candidates: TabCandidate[];
  /** The key the URL currently points at, ONLY if it is a live member; else null. */
  urlActiveKey: string | null;
  /** An explicit consume-once intent (chip click, deep open); else null. */
  pendingIntentKey: string | null;
}

export interface ResolveActiveResult {
  /** The key to make active, or null for an empty surface. */
  activeKey: string | null;
  source: ResolveSource;
  /** True iff the pending intent was the deciding factor — caller should consume it. */
  consumedPendingIntent: boolean;
}

export function resolveActive(input: ResolveActiveInput): ResolveActiveResult {
  const { candidates, urlActiveKey, pendingIntentKey } = input;
  const isMember = (key: string | null): key is string =>
    key != null && candidates.some((c) => c.key === key);

  // 1. URL explicit dock, target live → wins (URL is already the truth).
  if (isMember(urlActiveKey)) {
    return { activeKey: urlActiveKey, source: 'url', consumedPendingIntent: false };
  }

  // 2. Explicit pending intent in the list → wins, consumed.
  if (isMember(pendingIntentKey)) {
    return { activeKey: pendingIntentKey, source: 'intent', consumedPendingIntent: true };
  }

  // 5. Empty surface.
  if (candidates.length === 0) {
    return { activeKey: null, source: 'none', consumedPendingIntent: false };
  }

  // 3. Most-recently-active member (ties → lowest tabOrder).
  const byRecency = candidates
    .filter((c) => c.lastActiveAt != null)
    .sort((a, b) => (b.lastActiveAt as number) - (a.lastActiveAt as number) || a.tabOrder - b.tabOrder);
  if (byRecency.length > 0) {
    return { activeKey: byRecency[0].key, source: 'recency', consumedPendingIntent: false };
  }

  // 4. Lowest tabOrder (no recency signal anywhere).
  const byOrder = [...candidates].sort((a, b) => a.tabOrder - b.tabOrder);
  return { activeKey: byOrder[0].key, source: 'order', consumedPendingIntent: false };
}
