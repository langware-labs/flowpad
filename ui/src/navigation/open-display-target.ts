import { AgenticProcess, TypeId, type ReceiveShowTarget } from '@sdk';
import type { NavigationActions } from '@src/navigation';
import { ViewMode } from '@src/contexts/view-mode-context';
import { AssetDocPointer } from '@src/navigation/AssetDocPointer';
import { editorForType } from '@src/navigation/asset-doc-types';
import { dockForDisplayTarget } from '@src/navigation/display-target-pointer';
import { shellIdFromShowTarget } from '@src/navigation/shell-show-target';

/**
 * Navigate to the DisplayTarget an `install()` returned — the single place the
 * receive flow maps a backend-decided target to a nav call (URL-first; the FE
 * never decides WHAT to show, only routes what the backend chose).
 *
 * - an `agentic_process` target = a spawned Vibe setup session → open its shell
 *   in Vibe mode (the live app renders in the Vibe display as the agent works).
 * - an `app` target → open the app dock (addressed by what it was shown by).
 * - a `shell` target → open that terminal's dock; a mounted workspace adopts it
 *   as a child, which is how a journey's terminal gets there too.
 * - any other entity / vfs target → open it in its editor dock.
 */
export function openDisplayTarget(dt: ReceiveShowTarget | null | undefined, navigation: NavigationActions): void {
  if (!dt) return;

  if (dt.type === AgenticProcess.type && dt.id) {
    void navigation.openShellProcess(dt.id, { viewMode: ViewMode.Vibe });
    return;
  }
  if (dt.kind === 'app') {
    const dock = dockForDisplayTarget(dt);
    if (dock) navigation.openDock(dock);
    return;
  }
  const shellId = shellIdFromShowTarget(dt);
  if (shellId) {
    void navigation.openShell(shellId, { viewMode: ViewMode.Vibe });
    return;
  }
  const editor = dt.type ? editorForType(dt.type) : undefined;
  if (editor && dt.typeid) {
    navigation.openDock(AssetDocPointer.forTypeId(editor, new TypeId(dt.typeid)).toDockPointer());
    return;
  }
  if (dt.path) {
    navigation.openFile(dt.path);
  }
}
