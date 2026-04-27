import type { AgenticProcess } from '@sdk';

export interface SessionTab {
  id: string;
  name: string;
  favorite_index?: number | null;
}

/**
 * Module-level cache of rendered session tabs, keyed by project cacheKey.
 * SessionViewer keeps this in sync with its live state; other components
 * (e.g. the Ask-for-Assistance dialog) can read the current tab name from
 * here instead of recomputing.
 */
export const sessionTabsCache = new Map<string, SessionTab[]>();

/**
 * Look up the name currently shown on the tab bar for *processId*, scanning
 * across all cached projects. Returns null if no tab has been rendered for
 * this process yet (e.g. dialog opened before SessionViewer mounted).
 */
export const getCachedTabName = (processId: string): string | null => {
  if (!processId) return null;
  for (const tabs of sessionTabsCache.values()) {
    const match = tabs.find((t) => t.id === processId);
    if (match && match.name) return match.name;
  }
  return null;
};

/**
 * Compute the name shown on a session tab. Reused by anything else that
 * needs to label a session (e.g. the Ask-for-Assistance dialog) so the
 * tab and the rest of the UI never disagree.
 */
export const getSessionDisplayName = (
  process: AgenticProcess | null | undefined,
  fallback: string,
) => {
  if (process?.context_data && typeof process.context_data === 'object') {
    const displayName = (process.context_data as Record<string, unknown>).display_name;
    if (typeof displayName === 'string' && displayName.trim().length > 0) {
      return displayName.trim();
    }
  }

  // process.name mirrors Shell.name (via shell.py propagation) — this is the
  // Claude-generated PTY tab title shown in TabbedTerminal. Without this
  // fallback the dialog would say "Session" while the tab shows the real title.
  const procName = (process as { name?: string | null } | null | undefined)?.name;
  if (typeof procName === 'string' && procName.trim().length > 0) {
    return procName.trim();
  }

  if (process?.instruction_content) {
    const trimmed = process.instruction_content.replace(/<!--.*?-->/g, '').trim();
    if (trimmed.length > 0) {
      return trimmed.substring(0, 30);
    }
  }

  return fallback;
};

export const getNextSessionNumber = (tabs: SessionTab[]) => {
  let max = 0;
  for (const tab of tabs) {
    if (!tab.name) continue;
    const match = tab.name.match(/^Session\s+(\d+)$/i);
    if (match) {
      const value = Number.parseInt(match[1], 10);
      if (!Number.isNaN(value)) {
        max = Math.max(max, value);
      }
    }
  }
  return Math.max(max, tabs.length) + 1;
};

const isGenericSessionName = (name: string) => /^Session\s+\d+$/i.test(name);

/**
 * Merge freshly-fetched tabs into the existing (prev) tabs.
 *
 * Key rule: never overwrite an existing tab's name with a generic
 * "Session N" fallback, because the fallback is derived from the fetch-array
 * index and shifts when tabs are added / removed.  A "real" name (set from
 * display_name or instruction_content) is always accepted.
 */
/**
 * Filter out sessions that have been explicitly closed by the user.
 * Closed sessions still exist in the backend but should not reappear in the tab bar.
 */
export const filterClosedTabs = (tabs: SessionTab[], closedIds: Set<string>): SessionTab[] => {
  if (closedIds.size === 0) return tabs;
  return tabs.filter((tab) => !closedIds.has(tab.id));
};

export const mergeSessionTabs = (prev: SessionTab[], incoming: SessionTab[]): Map<string, SessionTab> => {
  const mergedById = new Map<string, SessionTab>();
  for (const tab of prev) {
    mergedById.set(tab.id, tab);
  }
  for (const tab of incoming) {
    const existing = mergedById.get(tab.id);
    if (existing) {
      const keepExistingName = isGenericSessionName(tab.name);
      mergedById.set(tab.id, {
        ...existing,
        ...tab,
        name: keepExistingName ? existing.name : tab.name,
      });
    } else {
      mergedById.set(tab.id, tab);
    }
  }
  return mergedById;
};
