/**
 * Opening what an automation is made of: its definition (the trigger.json it
 * lives in, else its own page) and, for a file automation, the folder or file
 * it watches. Clicks only navigate (URL-first).
 */
import type { AutomationSummary } from '@sdk';
import { LOCAL_COMPUTE_NODE } from '@src/navigation/asset-doc-types';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

/** The file an automation is defined in, when it has one. */
export function definitionFile(a: Pick<AutomationSummary, 'asset_ref'>): string | null {
  return a.asset_ref ? `${a.asset_ref.replace(/\/$/, '')}/trigger.json` : null;
}

export function useAutomationOpen() {
  const { navigation } = useDockNavigation();
  return {
    /** Its trigger.json in the editor; a rule with no file opens its own page. */
    openDefinition: (a: AutomationSummary) => {
      const file = definitionFile(a);
      if (file) navigation.openMachinePath(file, LOCAL_COMPUTE_NODE);
      else navigation.openDock(DockPointer.forAutomations({ trigger: a.id }));
    },
    /** The folder a file automation watches (browsed), or the one file it watches (opened). */
    browseWatched: (a: AutomationSummary) => {
      const file = a.when.file;
      if (!file?.path) return;
      if (file.is_folder) navigation.openFolder(file.path);
      else navigation.openMachinePath(file.path, LOCAL_COMPUTE_NODE);
    },
  };
}
