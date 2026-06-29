import { PREF_CATEGORIES, prefsForCategory } from '@sdk';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@src/components/ui/tabs';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { humanizeType } from '@src/tabs/provider-meta';
import { PrefControl } from './PrefControl';

/**
 * User Preferences screen — registry-driven, one tab per category. URL-first: the
 * active tab is derived from the dock pointer (`/dock/preferences/<category>`), and
 * switching tabs navigates rather than mutating local state.
 */
export function PreferencesView() {
  const { navigation, currentDock } = useDockNavigation();

  const categories = PREF_CATEGORIES;
  const pointer = currentDock?.pointer;
  const active = pointer && categories.includes(pointer) ? pointer : categories[0];

  return (
    <div className="flex h-full min-h-0 flex-col p-4">
      <h2 className="mb-3 shrink-0 text-lg font-semibold">Preferences</h2>
      <Tabs
        value={active}
        onValueChange={(cat) => navigation.openPreferences(cat)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList className="w-full shrink-0">
          {categories.map((cat) => (
            <TabsTrigger key={cat} value={cat} className="flex-1" data-testid={`pref-tab-${cat}`}>
              {humanizeType(cat)}
            </TabsTrigger>
          ))}
        </TabsList>

        {categories.map((cat) => (
          <TabsContent key={cat} value={cat} className="min-h-0 flex-1 overflow-y-auto">
            <div className="flex flex-col gap-6 p-2">
              {prefsForCategory(cat).map((info) => (
                <PrefControl key={info.key} info={info} />
              ))}
            </div>
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
