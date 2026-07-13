import { AgenticProcess, TypeId, type ReceiveShowTarget } from '@sdk';
import type { NavigationActions } from '@src/navigation';
import { ViewMode } from '@src/contexts/view-mode-context';
import { AssetDocPointer } from '@src/navigation/AssetDocPointer';
import { editorForType } from '@src/navigation/asset-doc-types';

/**
 * Navigate to the DisplayTarget an `install()` returned — the single place the
 * receive flow maps a backend-decided target to a nav call (URL-first; the FE
 * never decides WHAT to show, only routes what the backend chose).
 *
 * - an `agentic_process` target = a spawned Vibe setup session → open its shell
 *   in Vibe mode (the live app renders in the Vibe display as the agent works).
 * - a `webapp` target → open the port preview.
 * - any other entity / vfs target → open it in its editor dock.
 */
export function openDisplayTarget(dt: ReceiveShowTarget | null | undefined, navigation: NavigationActions): void {
  if (!dt) return;

  if (dt.type === AgenticProcess.type && dt.id) {
    void navigation.openShellProcess(dt.id, { viewMode: ViewMode.Vibe });
    return;
  }
  if (dt.kind === 'webapp' && dt.port != null) {
    navigation.openWebApp(String(dt.port));
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
