import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { AssetDocPointer } from '@src/navigation/AssetDocPointer';
import { AssetMode, WIKI_FRAGMENT_PARAM } from '@src/navigation/asset-doc-types';
import { WikiResolveView } from './editor/WikiResolveView';

/**
 * Hub asset surface.
 *
 * Hub currently exposes Wiki-addressed assets, not the Desk's local inventory,
 * creation, index-status, or filesystem navigator. Keep this shell narrow so a
 * Hub Wiki route does not mount local-only asset hooks.
 */
export function HubAssetsPage() {
  const { currentDock } = useDockNavigation();
  let pointer: AssetDocPointer | null = null;
  try {
    pointer = AssetDocPointer.parse(currentDock?.pointer);
    pointer.validate();
  } catch {
    pointer = null;
  }

  if (!pointer || pointer.mode !== AssetMode.WIKI) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Invalid Hub Wiki asset URL
      </div>
    );
  }

  return (
    <div className="h-full min-h-0">
      <WikiResolveView
        name={pointer.wikiName}
        space={pointer.space}
        fragment={currentDock?.options?.[WIKI_FRAGMENT_PARAM]}
        authority="hub"
      />
    </div>
  );
}
