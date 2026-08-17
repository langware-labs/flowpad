import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { AssetDocPointer } from '@src/navigation/AssetDocPointer';
import { AssetMode, WIKI_FRAGMENT_PARAM } from '@src/navigation/asset-doc-types';
import { AssetEditorRouter } from './editor/AssetEditorRouter';
import { WikiResolveView } from './editor/WikiResolveView';

/**
 * Hub asset surface.
 *
 * Two addressed shapes, both read-oriented — never the Desk's local inventory,
 * creation, index-status or filesystem navigator. Keep this shell narrow so a
 * Hub route does not mount local-only asset hooks.
 *
 * EDITOR mode is what a shared link resolves to: `<type>-<uuid>` with no project
 * segment, because a doc shared directly with someone grants them the asset and
 * nothing else — they may well have no access to (or knowledge of) its project.
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

  if (pointer?.mode === AssetMode.EDITOR && currentDock?.pointer) {
    // Same call as HubProjectPage; `hubReflect` routes reads at the Hub.
    return (
      <div className="h-full min-h-0">
        <AssetEditorRouter pointer={currentDock.pointer} hubReflect />
      </div>
    );
  }

  if (!pointer || pointer.mode !== AssetMode.WIKI) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Invalid Hub asset URL
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
