import { HUB_TABS } from '@src/components/items/home-tabs';
import { ItemsSection } from '@src/components/items/ItemsSection';

export { PAGE_SIZE } from '@src/components/items/ItemsSection';

/** The hub home's items: the shared section with the hub's tabs (`components/items/home-tabs.tsx`). */
export function HubItemsSection({ onCreate }: { onCreate: () => void }) {
  return <ItemsSection tabs={HUB_TABS} onCreate={onCreate} prefKey="hub-home" />;
}
