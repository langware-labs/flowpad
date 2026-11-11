import { Trans, useLingui } from '@lingui/react/macro';
import {
  instancePreferences,
  isPrefVisible,
  PREF_GROUPS,
  PREF_REGISTRY,
  PrefInfo,
  PrefKey,
  PrefTab,
  resolvePreferencesPointer,
} from '@sdk';
import { SettingsCard } from '@src/components/settings/settings-card';
import { Input } from '@src/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@src/components/ui/tabs';
import { usePreferencesVersion } from '@src/hooks/use-preference';
import { translatePrefDescription, translatePrefLabel, translatePrefLayout } from '@src/i18n/pref-labels';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { humanizeType } from '@src/tabs/provider-meta';
import { useState } from 'react';
import { PrefControl } from './PrefControl';
import { TraceLoggingSection } from './TraceLoggingSection';

/** Reads live values for the `visibleWhen` filter; no stable identity needed. */
const readPref = (key: PrefKey) => instancePreferences.get(key);
const ALL_TABS = PREF_GROUPS.flatMap((g) => g.tabs);

const layoutName = (id: string) => translatePrefLayout(id, humanizeType(id.split('/').pop() ?? id));

function visibleRows(tab: PrefTab): PrefInfo[] {
  return tab.keys.map((key) => PREF_REGISTRY[key]).filter((info) => isPrefVisible(info, readPref));
}

/** The row's title and help text, as shown, contain `needle` (lower-case). */
function prefMatches(info: PrefInfo, needle: string): boolean {
  const text = `${translatePrefLabel(info.key, info.label)} ${translatePrefDescription(info.key, info.description) ?? ''}`;
  return text.toLowerCase().includes(needle);
}

function PrefRows({ infos }: { infos: PrefInfo[] }) {
  return (
    <SettingsCard>
      {infos.map((info) => (
        <PrefControl key={info.key} info={info} />
      ))}
    </SettingsCard>
  );
}

/**
 * User Preferences screen: groups in a left menu, tabs inside each group
 * (`ts_sdk/src/preferences/prefLayout.ts`). URL-first: the open group and tab come
 * from the dock pointer (`/dock/preferences/<group>/<tab>`, an old category pointer
 * resolves to its tab now), and every click only navigates.
 */
export function PreferencesView() {
  const { navigation, currentDock } = useDockNavigation();
  const { t } = useLingui();
  const [query, setQuery] = useState('');

  // Re-render on any preference change so `visibleWhen` rows appear/disappear the
  // moment their controller flips.
  usePreferencesVersion();

  const { group, tab } = resolvePreferencesPointer(currentDock?.pointer);
  const needle = query.trim().toLowerCase();
  const matches = needle ? ALL_TABS.flatMap(visibleRows).filter((info) => prefMatches(info, needle)) : [];

  return (
    <div className="h-full min-h-0 w-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-col px-5 py-8">
        <header className="mb-6">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            <Trans>Preferences</Trans>
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            <Trans>Tune Flowpad to how you work — changes save automatically.</Trans>
          </p>
        </header>

        <div className="flex gap-8">
          <nav className="flex w-48 shrink-0 flex-col gap-1" aria-label={t`Preference groups`}>
            <Input
              className="mb-3"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t`Search settings`}
              data-testid="pref-search"
            />
            {PREF_GROUPS.map((g) => {
              const current = !needle && g.id === group.id;
              return (
                <button
                  key={g.id}
                  type="button"
                  data-testid={`pref-group-${g.id}`}
                  aria-current={current ? 'page' : undefined}
                  onClick={() => {
                    setQuery('');
                    navigation.openPreferences(`${g.id}/${g.tabs[0].id}`);
                  }}
                  className={`w-full rounded-md px-3 py-1.5 text-start text-sm font-medium ${
                    current ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/50'
                  }`}
                >
                  {layoutName(g.id)}
                </button>
              );
            })}
          </nav>

          <div className="min-w-0 flex-1">
            {needle ? (
              matches.length ? (
                <PrefRows infos={matches} />
              ) : (
                <p className="text-sm text-muted-foreground">
                  <Trans>No setting matches “{query}”.</Trans>
                </p>
              )
            ) : (
              <>
                <Tabs value={tab.id} onValueChange={(id) => navigation.openPreferences(`${group.id}/${id}`)}>
                  <TabsList className="mb-6 h-auto w-full flex-wrap justify-start gap-1">
                    {group.tabs.map((tb) => (
                      <TabsTrigger key={tb.id} value={tb.id} data-testid={`pref-tab-${group.id}-${tb.id}`}>
                        {layoutName(`${group.id}/${tb.id}`)}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
                {tab.custom === 'toplog' ? <TraceLoggingSection /> : <PrefRows infos={visibleRows(tab)} />}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
