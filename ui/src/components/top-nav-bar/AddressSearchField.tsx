import { useEffect, useMemo, useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { Loader2, Search, X } from 'lucide-react';
import { Command, CommandEmpty, CommandItem, CommandList } from '@src/components/ui/command';
import { Popover, PopoverAnchor, PopoverContent } from '@src/components/ui/popover';
import { activateSearchRow } from '@src/components/spotlight/activate-row';
import { searchResultToRow } from '@src/components/spotlight/adapters';
import { SpotlightResultRowContent } from '@src/components/spotlight/SpotlightResultRow';
import type { SpotlightRow } from '@src/components/spotlight/types';
import { useDefaultScopeFilter } from '@src/hooks/use-default-scope-filter';
import { MIN_SEARCH_QUERY_LENGTH, useRecordSearch } from '@src/hooks/use-record-search';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ADDRESS_PILL_CLASS } from './address-pill';

/**
 * The address bar in search mode — the browser omnibox move: the same pill that
 * shows where you are becomes where you type, and the results drop under it.
 *
 * Everything below the input is BORROWED, not rebuilt: the debounced FTS hook,
 * the result-row adapter, the row content component, and `activateSearchRow`
 * (the "row's own opener first, record-type router as fallback" rule) are the
 * ones Spotlight and the navigator search already use. This file only supplies
 * the omnibox shell around them.
 *
 * The list is a cmdk `Command` rather than a stack of buttons, so ↑/↓/Enter
 * work — an address bar is reached from the keyboard, and a result you can
 * only click is half a feature. Scope follows the active project like every
 * other search surface; the type and scope chips stay in Spotlight, since an
 * address bar that grows a settings panel stops being an address bar.
 */
export function AddressSearchField({ onClose }: { onClose: () => void }) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const [query, setQuery] = useState('');
  const [opening, setOpening] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const [scope] = useDefaultScopeFilter();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (fieldRef.current?.contains(target) || resultsRef.current?.contains(target)) return;
      onClose();
    };

    window.addEventListener('pointerdown', closeOutside, true);
    return () => window.removeEventListener('pointerdown', closeOutside, true);
  }, [onClose]);

  const { results, isLoading } = useRecordSearch(query, undefined, {}, scope, 250);
  const rows = useMemo(() => results.map(searchResultToRow), [results]);
  // The hook itself refuses to search below this length, so opening the panel
  // any earlier would mount a portal to say "No matches" about a search that
  // never ran.
  const searchable = query.trim().length >= MIN_SEARCH_QUERY_LENGTH;

  const select = async (row: SpotlightRow) => {
    setOpening(row.key);
    await activateSearchRow(row, navigation);
    onClose();
  };

  return (
    // Anchored, never triggered: the pill IS the anchor, and the panel's open
    // state is the query — a trigger would toggle it out from under the typing.
    <Popover open={searchable} modal={false}>
      <Command shouldFilter={false} className="contents">
        <PopoverAnchor asChild>
          <div
            ref={fieldRef}
            data-testid="top-nav-search"
            className={`${ADDRESS_PILL_CLASS} border-primary ring-1 ring-primary/30`}
          >
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              // Escape leaves search and gives the address back — the same key
              // that abandons a half-typed URL in a browser. The arrows and
              // Enter go to cmdk, which owns the result selection.
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  onClose();
                }
              }}
              placeholder={t`Search…`}
              aria-label={t`Search`}
              data-testid="top-nav-search-input"
              className="h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
            />
            {isLoading && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />}
            <button
              type="button"
              onClick={onClose}
              aria-label={t`Close search`}
              data-testid="top-nav-search-close"
              className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </PopoverAnchor>
        <PopoverContent
          ref={resultsRef}
          align="start"
          // The panel must never steal the caret — you are still typing into the
          // bar while it opens, re-renders, and re-sorts underneath you.
          onOpenAutoFocus={(e) => e.preventDefault()}
          className="w-[var(--radix-popover-trigger-width)] p-1"
          data-testid="top-nav-search-results"
        >
          <CommandList className="max-h-[420px]">
            <CommandEmpty className="px-3 py-6 text-center text-sm text-muted-foreground">
              {isLoading ? t`Searching…` : t`No matches.`}
            </CommandEmpty>
            {rows.map((row) => (
              <CommandItem
                key={row.key}
                value={row.key}
                onSelect={() => void select(row)}
                data-testid="top-nav-search-result"
                data-record-type={row.recordType}
                className="px-2 py-1.5"
              >
                <SpotlightResultRowContent row={row} opening={opening === row.key} />
              </CommandItem>
            ))}
          </CommandList>
        </PopoverContent>
      </Command>
    </Popover>
  );
}
