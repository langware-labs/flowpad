import { Trans } from '@lingui/react/macro';
import { instancePreferences, PREF_CATEGORIES, PrefKey, visiblePrefsForCategory } from '@sdk';
import { SettingsCard } from '@src/components/settings/settings-card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@src/components/ui/tabs';
import { usePreferencesVersion } from '@src/hooks/use-preference';
import { translatePrefCategory } from '@src/i18n/pref-labels';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { humanizeType } from '@src/tabs/provider-meta';
import { PrefControl } from './PrefControl';

/** Reads live values for the `visibleWhen` filter; no stable identity needed. */
const readPref = (key: PrefKey) => instancePreferences.get(key);

/**
 * User Preferences screen — registry-driven, one tab per category. URL-first: the
 * active tab is derived from the dock pointer (`/dock/preferences/<category>`), and
 * switching tabs navigates rather than mutating local state.
 *
 * Layout: a single centered, width-constrained column so every control sits right
 * next to its label (instead of being flung to the far edge of a wide panel), and
 * each category's prefs are grouped into one bordered card with hairline dividers so
 * a row's control always reads as belonging to its label.
 */
export function PreferencesView() {
  const { navigation, currentDock } = useDockNavigation();

  // Re-render on any preference change so `visibleWhen` rows appear/disappear the
  // moment their controller flips. One subscription regardless of row count —
  // reading each controller with its own hook would make the hook count depend on
  // the data. `set()` emits synchronously, so this lands in the same tick as the
  // toggle rather than after the debounced save.
  usePreferencesVersion();

  const categories = PREF_CATEGORIES;
  const pointer = currentDock?.pointer;
  const active = pointer && categories.includes(pointer) ? pointer : categories[0];

  return (
    <div className="h-full min-h-0 w-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col px-5 py-8">
        <header className="mb-6">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            <Trans>Preferences</Trans>
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            <Trans>Tune Flowpad to how you work — changes save automatically.</Trans>
          </p>
        </header>

        <Tabs value={active} onValueChange={(cat) => navigation.openPreferences(cat)} className="flex flex-col">
          {/*
            `h-auto flex-wrap` + natural-width triggers, deliberately: with a tab
            per category the row's min-content width already exceeds the column,
            and `flex-1` can't shrink a `whitespace-nowrap` trigger below its text.
            The list is centered, so the overflow spilled out BOTH edges of the
            pill — visible in English, worse in locales whose words run longer.
            Wrapping to a second row keeps every tab reachable (a scroller would
            hide some) and holds in RTL, where `justify-start` follows `dir`.
          */}
          <TabsList className="mb-6 h-auto w-full flex-wrap justify-start gap-1">
            {categories.map((cat) => (
              <TabsTrigger key={cat} value={cat} data-testid={`pref-tab-${cat}`}>
                {translatePrefCategory(cat, humanizeType(cat))}
              </TabsTrigger>
            ))}
          </TabsList>

          {categories.map((cat) => (
            <TabsContent key={cat} value={cat} className="mt-0 focus-visible:outline-none">
              <SettingsCard>
                {visiblePrefsForCategory(cat, readPref).map((info) => (
                  <PrefControl key={info.key} info={info} />
                ))}
              </SettingsCard>
            </TabsContent>
          ))}
        </Tabs>
      </div>
    </div>
  );
}
