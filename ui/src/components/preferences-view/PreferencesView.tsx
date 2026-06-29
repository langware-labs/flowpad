import { PREF_CATEGORIES, prefsForCategory } from '@sdk';
import { Card } from '@src/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@src/components/ui/tabs';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { humanizeType } from '@src/tabs/provider-meta';
import { PrefControl } from './PrefControl';

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

  const categories = PREF_CATEGORIES;
  const pointer = currentDock?.pointer;
  const active = pointer && categories.includes(pointer) ? pointer : categories[0];

  return (
    <div className="h-full min-h-0 w-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col px-5 py-8">
        <header className="mb-6">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">Preferences</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Tune Flowpad to how you work — changes save automatically.
          </p>
        </header>

        <Tabs value={active} onValueChange={(cat) => navigation.openPreferences(cat)} className="flex flex-col">
          <TabsList className="mb-6 w-full">
            {categories.map((cat) => (
              <TabsTrigger key={cat} value={cat} className="flex-1" data-testid={`pref-tab-${cat}`}>
                {humanizeType(cat)}
              </TabsTrigger>
            ))}
          </TabsList>

          {categories.map((cat) => (
            <TabsContent key={cat} value={cat} className="mt-0 focus-visible:outline-none">
              <Card className="divide-y divide-border/60 overflow-hidden border-border/70 bg-card/30 shadow-sm">
                {prefsForCategory(cat).map((info) => (
                  <PrefControl key={info.key} info={info} />
                ))}
              </Card>
            </TabsContent>
          ))}
        </Tabs>
      </div>
    </div>
  );
}
