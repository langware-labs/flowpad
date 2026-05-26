import type { SearchResult } from '@src/hooks/use-record-search';
import type { NavigationActions } from '@src/navigation/NavigationActions';

export interface SpotlightRow {
  key: string;
  recordType: string;
  title: string;
  subtitle?: string;
  timestamp?: string | null;
  /** When set, click routes through navigateToResult(searchResult, navigation). */
  searchResult?: SearchResult;
  /** Primary click handler. Returns `true` if it navigated (or otherwise
   *  fully handled the click), `false` if the caller should fall through to
   *  `searchResult` + `navigateToResult`. Used by worker-history rows and
   *  terminal-profile FTS rows so a missing AgenticProcess falls back to the
   *  transcript lens instead of a dead-end toast. */
  onActivate?: (navigation: NavigationActions) => Promise<boolean> | boolean;
}

export interface SpotlightInitialInfo {
  rows: SpotlightRow[];
  isLoading: boolean;
}

export interface SpotlightProfile {
  id: string;
  label?: string;
  placeholder?: string;
  defaultEntityType?: string;
  allowedEntityTypes?: string[];
  /** When true, the FTS row click resolves the worker via AgenticProcess.getByWorkerId
   *  and opens the terminal dock pointer (live PTY), bypassing the shared
   *  record-type-nav router which would route to the transcript lens. Used by
   *  the terminal profile to preserve parity with the legacy SessionQuickSearchModal. */
  routeViaTerminal?: boolean;
  /** When true, the empty-query state is populated from worker history
   *  (useTerminalInitialRows). The hook is always mounted by `Spotlight`; this
   *  flag just gates whether its results are surfaced and whether the hook
   *  itself runs (enabled). */
  showTerminalHistory?: boolean;
}
