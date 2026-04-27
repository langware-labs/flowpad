import type { AgenticProcess } from '@sdk';

export interface SessionTab {
  id: string;
  name: string;
  favorite_index?: number | null;
}

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
