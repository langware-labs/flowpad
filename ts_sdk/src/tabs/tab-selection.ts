import { Tab } from '../entities/tab';
import { tabInProject, tabLastActiveMs, tabTargetKey } from './tab-selectors';

export { tabLastActiveMs } from './tab-selectors';

export interface TabCandidate {
  key: string;
  lastActiveAt: number | null;
  tabOrder: number;
}

export type ResolveSource = 'url' | 'intent' | 'recency' | 'order' | 'none';

export interface ResolveActiveInput {
  candidates: TabCandidate[];
  urlActiveKey: string | null;
  pendingIntentKey: string | null;
}

export interface ResolveActiveResult {
  activeKey: string | null;
  source: ResolveSource;
  consumedPendingIntent: boolean;
}

export interface ResolveNextTabInput {
  tabs: readonly Tab[];
  excludeIds?: ReadonlySet<string>;
  preferProjectId?: string | null;
  pendingIntentKey?: string | null;
}

export interface ResolveNextTabResult {
  tab: Tab | null;
  consumedPendingIntent: boolean;
}

/** Resolve a selected candidate without reading or mutating application state. */
export function resolveActive(input: ResolveActiveInput): ResolveActiveResult {
  const { candidates, urlActiveKey, pendingIntentKey } = input;
  const isMember = (key: string | null): key is string =>
    key != null && candidates.some((candidate) => candidate.key === key);

  if (isMember(urlActiveKey)) {
    return { activeKey: urlActiveKey, source: 'url', consumedPendingIntent: false };
  }

  if (isMember(pendingIntentKey)) {
    return { activeKey: pendingIntentKey, source: 'intent', consumedPendingIntent: true };
  }

  if (candidates.length === 0) {
    return { activeKey: null, source: 'none', consumedPendingIntent: false };
  }

  const byRecency = candidates
    .filter((candidate) => candidate.lastActiveAt != null)
    .sort(
      (left, right) =>
        (right.lastActiveAt as number) - (left.lastActiveAt as number) || left.tabOrder - right.tabOrder,
    );
  if (byRecency.length > 0) {
    return { activeKey: byRecency[0].key, source: 'recency', consumedPendingIntent: false };
  }

  const byOrder = [...candidates].sort((left, right) => left.tabOrder - right.tabOrder);
  return { activeKey: byOrder[0].key, source: 'order', consumedPendingIntent: false };
}

/**
 * Resolve the next eligible tab without consuming a manager's pending intent.
 * The caller performs consumption only when `consumedPendingIntent` is true.
 */
export function resolveNextTabPure(input: ResolveNextTabInput): ResolveNextTabResult {
  const { tabs, excludeIds = new Set<string>(), pendingIntentKey = null, preferProjectId } = input;
  const scoped = preferProjectId === undefined ? tabs : tabs.filter((tab) => tabInProject(tab, preferProjectId));
  const eligible = scoped.filter((tab) => {
    if (tab.is_disabled || !tab.target_id) return false;
    return !excludeIds.has(tabTargetKey(tab)) && !excludeIds.has(tab.target_id);
  });

  const result = resolveActive({
    candidates: eligible.map((tab) => ({
      key: tabTargetKey(tab),
      lastActiveAt: tabLastActiveMs(tab),
      tabOrder: tab.tab_order,
    })),
    urlActiveKey: null,
    pendingIntentKey,
  });

  return {
    tab: result.activeKey
      ? (eligible.find((tab) => tabTargetKey(tab) === result.activeKey) ?? null)
      : null,
    consumedPendingIntent: result.consumedPendingIntent,
  };
}
