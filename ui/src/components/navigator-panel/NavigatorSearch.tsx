import { Loader2, Search, Settings2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLingui } from '@lingui/react/macro';
import { useRecordSearch } from '@src/hooks/use-record-search';
import { useMultiTypeSearch } from '@src/components/spotlight/useMultiTypeSearch';
import { activateSearchRow } from '@src/components/spotlight/activate-row';
import { searchResultToRow, searchResultToTerminalRow } from '@src/components/spotlight/adapters';
import { SpotlightResultRowContent } from '@src/components/spotlight/SpotlightResultRow';
import { EntityTypePopover } from '@src/components/spotlight/EntityTypePopover';
import { ScopeFilterPopover } from '@src/components/spotlight/ScopeFilterPopover';
import type { SpotlightRow } from '@src/components/spotlight/types';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useDefaultScopeFilter } from '@src/hooks/use-default-scope-filter';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import type { NavigatorSearchConfig } from './types';

/** Stable empty fallback so a config-less navigator keeps a constant
 *  `recordTypes` identity (no per-render array churn through the search hooks). */
const EMPTY_RECORD_TYPES: string[] = [];

export interface NavigatorSearchOutput {
  /** True while search mode is active (input replaces the title row). */
  active: boolean;
  /** Magnifier button for the header trailing slot (null when no config). */
  searchIcon: ReactNode | null;
  /** Inner content of the morphed title row: input + settings + close. */
  headerRow: ReactNode | null;
  /** Results body to render in the navigator's scroll area while active. */
  body: ReactNode | null;
}

/**
 * Inline, context-aware navigator search — the global Spotlight machinery
 * (debounced FTS, type/scope settings, result rows, navigation) lifted into the
 * shared `NavigatorPanel` so every side menu gets the same search-icon →
 * morph-row → results-in-list experience.
 *
 * Called unconditionally by `NavigatorPanel` (hooks stay stable); returns inert
 * outputs when `config` is absent. The panel decides where to place the icon,
 * the morphed header row, and the results body.
 */
export function useNavigatorSearch(config: NavigatorSearchConfig | null | undefined): NavigatorSearchOutput {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();

  const [active, setActive] = useState(false);
  const [query, setQuery] = useState('');
  const [entityType, setEntityType] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Own scope state (so the settings popover can change it), seeded from the
  // navigator's current scope when search opens.
  const [scope, setScope, currentProjectId] = useDefaultScopeFilter();

  const recordTypes = config?.recordTypes ?? EMPTY_RECORD_TYPES;
  const configScope = config?.scope ?? null;

  // On activation: preset the type filter (single type → pinned; multiple →
  // "All"), seed the scope from the navigator, and focus the input.
  useEffect(() => {
    if (!active) return;
    setEntityType(recordTypes.length === 1 ? recordTypes[0] : null);
    if (configScope) setScope(configScope);
    inputRef.current?.focus();
    // Re-seed only on the open transition, not on every scope/type change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const close = useCallback(() => {
    setActive(false);
    setQuery('');
    setSettingsOpen(false);
  }, []);

  // Multi-type fan-out when no single type is pinned and the menu lists >1 type.
  const useMulti = !entityType && recordTypes.length > 1;
  const single = useRecordSearch(
    useMulti ? '' : query,
    entityType ? { record_type: entityType } : undefined,
    {},
    scope,
    250,
  );
  const multi = useMultiTypeSearch(useMulti ? query : '', recordTypes, scope, 250);

  const results = useMulti ? multi.results : single.results;
  const routeViaTerminal = config?.routeViaTerminal ?? false;
  const rows = useMemo(
    () => results.map(routeViaTerminal ? searchResultToTerminalRow : searchResultToRow),
    [results, routeViaTerminal],
  );
  const isSearching = useMulti ? multi.isLoading : single.isLoading;
  const trimmed = query.trim();

  const handleSelect = useCallback(
    async (row: SpotlightRow) => {
      setOpening(row.key);
      try {
        await activateSearchRow(row, navigation);
        close();
      } finally {
        setOpening(null);
      }
    },
    [navigation, close],
  );

  if (!config) return { active: false, searchIcon: null, headerRow: null, body: null };

  const searchIcon = (
    <button
      type="button"
      onClick={() => setActive(true)}
      title={t`Search`}
      aria-label={t`Search`}
      className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded hover:bg-muted"
      data-testid="navigator-search-open"
    >
      <Search className="h-3.5 w-3.5 text-muted-foreground" />
    </button>
  );

  const headerRow = (
    <>
      <Search className="ml-0.5 h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            close();
          }
        }}
        placeholder={config.placeholder ?? t`Search…`}
        aria-label={config.placeholder ?? t`Search`}
        className="h-6 min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
        data-testid="navigator-search-input"
      />
      {isSearching && <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-muted-foreground" />}
      <Popover open={settingsOpen} onOpenChange={setSettingsOpen} modal={false}>
        <PopoverTrigger asChild>
          <button
            type="button"
            title={t`Search settings`}
            aria-label={t`Search settings`}
            className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded hover:bg-muted"
            data-testid="navigator-search-settings"
          >
            <Settings2 className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-64 space-y-2 p-2" onOpenAutoFocus={(e) => e.preventDefault()}>
          <div>
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {t`Type`}
            </div>
            <EntityTypePopover value={entityType} onChange={setEntityType} allowedEntityTypes={recordTypes} />
          </div>
          <div>
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {t`Scope`}
            </div>
            <ScopeFilterPopover scope={scope} currentProjectId={currentProjectId} onScopeChange={setScope} />
          </div>
        </PopoverContent>
      </Popover>
      <button
        type="button"
        onClick={close}
        title={t`Close search`}
        aria-label={t`Close search`}
        className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded hover:bg-muted"
        data-testid="navigator-search-close"
      >
        <X className="h-3.5 w-3.5 text-muted-foreground" />
      </button>
    </>
  );

  const body = (
    <div className="py-1" data-testid="navigator-search-results">
      {!trimmed ? (
        <div className="px-3 py-6 text-center text-xs text-muted-foreground">{t`Type to search…`}</div>
      ) : isSearching && rows.length === 0 ? (
        <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> {t`Searching…`}
        </div>
      ) : rows.length === 0 ? (
        <div className="px-3 py-6 text-center text-xs text-muted-foreground">{t`No matches.`}</div>
      ) : (
        rows.map((row) => (
          <button
            key={row.key}
            type="button"
            onClick={() => void handleSelect(row)}
            className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-muted"
            data-testid="navigator-search-result"
            data-record-type={row.recordType}
          >
            <SpotlightResultRowContent row={row} opening={opening === row.key} />
          </button>
        ))
      )}
    </div>
  );

  return { active, searchIcon, headerRow, body };
}
