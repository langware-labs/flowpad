import { i18n } from '@lingui/core';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@src/components/ui/command';
import { Dialog, DialogContent, DialogTitle } from '@src/components/ui/dialog';
import { useRecordSearch } from '@src/hooks/use-record-search';
import { useDefaultScopeFilter } from '@src/hooks/use-default-scope-filter';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { closeSpotlight, useSpotlightStore } from '@src/store/use-spotlight-store';
import { Loader2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { EntityTypePopover } from './EntityTypePopover';
import { ScopeFilterPopover } from './ScopeFilterPopover';
import { activateSearchRow } from './activate-row';
import { searchResultToRow, searchResultToTerminalRow } from './adapters';
import { SpotlightResultRowContent } from './SpotlightResultRow';
import { resolveProfile } from './profiles';
import type { SpotlightInitialInfo, SpotlightProfile, SpotlightRow } from './types';
import { useMultiTypeSearch } from './useMultiTypeSearch';
import { useTerminalInitialRows } from './useTerminalInitialRows';

const EMPTY_INITIAL: SpotlightInitialInfo = { rows: [], isLoading: false };

export function Spotlight() {
  const { t } = useLingui();
  const open = useSpotlightStore((s) => s.open);
  const { navigation, currentDock } = useDockNavigation();

  // Pin the profile at the moment of open so dock changes during a session
  // don't yank the input mid-typing. Re-resolves on next open.
  const [pinnedProfile, setPinnedProfile] = useState<SpotlightProfile | null>(null);
  useEffect(() => {
    if (open && !pinnedProfile) {
      setPinnedProfile(resolveProfile(currentDock?.viewType));
    } else if (!open && pinnedProfile) {
      setPinnedProfile(null);
    }
  }, [open, currentDock?.viewType, pinnedProfile]);

  const profile = pinnedProfile ?? resolveProfile(currentDock?.viewType);

  const [query, setQuery] = useState('');
  const [entityType, setEntityType] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [scope, setScope, currentProjectId] = useDefaultScopeFilter();

  // Reset transient state when the modal closes.
  useEffect(() => {
    if (!open) {
      setQuery('');
      setEntityType(null);
      setOpening(null);
    } else if (pinnedProfile) {
      setEntityType(pinnedProfile.defaultEntityType ?? null);
    }
  }, [open, pinnedProfile]);

  // Always call the terminal-history hook unconditionally — gating via the
  // `enabled` arg keeps hook ORDER stable across renders even when the active
  // profile changes between opens (Rules of Hooks).
  const wantsTerminalHistory = open && !!profile.showTerminalHistory;
  const terminalInitial = useTerminalInitialRows(wantsTerminalHistory);
  const initialInfo: SpotlightInitialInfo = profile.showTerminalHistory ? terminalInitial : EMPTY_INITIAL;

  // Search drivers. The multi-type fallback runs when the popover shows
  // "All" with multiple allowed types; otherwise a single-type useRecordSearch.
  const multiTypes = useMemo(() => {
    if (entityType) return [];
    return profile.allowedEntityTypes ?? [];
  }, [entityType, profile.allowedEntityTypes]);
  const useMulti = !entityType && multiTypes.length > 0;

  const single = useRecordSearch(
    useMulti ? '' : query,
    entityType ? { record_type: entityType } : undefined,
    {},
    scope,
    250,
  );
  const multi = useMultiTypeSearch(useMulti ? query : '', multiTypes, scope, 250);

  const trimmed = query.trim();
  const ftsRows: SpotlightRow[] = useMemo(() => {
    const results = useMulti ? multi.results : single.results;
    const adapt = profile.routeViaTerminal ? searchResultToTerminalRow : searchResultToRow;
    return results.map(adapt);
  }, [useMulti, multi.results, single.results, profile.routeViaTerminal]);

  const isSearching = useMulti ? multi.isLoading : single.isLoading;

  const visible = trimmed ? ftsRows : (initialInfo?.rows ?? []);

  const handleSelect = async (row: SpotlightRow) => {
    setOpening(row.key);
    try {
      await activateSearchRow(row, navigation);
      closeSpotlight();
    } finally {
      setOpening(null);
    }
  };

  const placeholder = profile.placeholder ? i18n._(profile.placeholder) : t`Search…`;
  // Hide the entity chip when only one type is allowed AND it's pinned (no meaningful choice).
  const hideEntityChip = profile.allowedEntityTypes?.length === 1 && !!profile.defaultEntityType;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) closeSpotlight();
      }}
    >
      <DialogContent className="overflow-hidden p-0 sm:max-w-[720px]">
        <DialogTitle className="sr-only">{profile.label ? i18n._(profile.label) : t`Search`}</DialogTitle>
        <Command
          shouldFilter={false}
          className="[&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-2"
        >
          <div className="flex items-center gap-1 border-b px-2 py-1.5" data-testid="spotlight-header">
            <ScopeFilterPopover scope={scope} currentProjectId={currentProjectId} onScopeChange={setScope} />
            {!hideEntityChip && (
              <EntityTypePopover
                value={entityType}
                onChange={setEntityType}
                allowedEntityTypes={profile.allowedEntityTypes}
              />
            )}
            <div className="ms-1 flex-1">
              <CommandInput
                value={query}
                onValueChange={setQuery}
                placeholder={placeholder}
                data-testid="spotlight-input"
                className="h-9 border-0 px-0"
              />
            </div>
          </div>
          <CommandList className="max-h-[440px]">
            {!trimmed && initialInfo?.isLoading && visible.length === 0 ? (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> <Trans>Loading history…</Trans>
              </div>
            ) : trimmed && isSearching && visible.length === 0 ? (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> <Trans>Searching…</Trans>
              </div>
            ) : visible.length === 0 ? (
              <CommandEmpty className="py-6 text-sm text-muted-foreground">
                {trimmed ? t`No matches.` : profile.showTerminalHistory ? t`No recent items.` : t`Type to search…`}
              </CommandEmpty>
            ) : (
              visible.map((row) => (
                <CommandItem
                  key={row.key}
                  value={row.key}
                  onSelect={() => void handleSelect(row)}
                  data-testid="spotlight-result"
                  data-record-type={row.recordType}
                >
                  <SpotlightResultRowContent row={row} opening={opening === row.key} />
                </CommandItem>
              ))
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
