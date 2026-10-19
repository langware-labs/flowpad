import { navigateToResult } from '@src/navigation/record-type-nav';
import type { NavigationActions } from '@src/navigation/NavigationActions';
import type { SpotlightRow } from './types';

/**
 * Open what a search result points at — the one rule shared by every search
 * surface (the Spotlight dialog, the navigator's inline search, the address
 * bar's omnibox).
 *
 * The subtlety worth having in one place: a row's own `onActivate` may report
 * `false`, meaning "I could not handle this after all" — a terminal-profile row
 * whose `AgenticProcess` has been pruned, say. That falls through to the shared
 * record-type router, which typically opens the transcript lens, instead of
 * dead-ending in a toast.
 */
export async function activateSearchRow(row: SpotlightRow, navigation: NavigationActions): Promise<void> {
  const handled = row.onActivate ? await row.onActivate(navigation) : false;
  if (!handled && row.searchResult) await navigateToResult(row.searchResult, navigation);
}
