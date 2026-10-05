/**
 * NavigationDecision in the UI: what was typed → a DockPointer to navigate, OR a prompt to ask.
 *
 * The backend decides (`flow_sdk/core/navigation_decision.py`) and, for every target it can
 * address, already answers the dock address. This file only turns the answer into a
 * `DockPointer` — building it here for the file / URL / web-app targets whose vfs and
 * editor-for-path rules are TypeScript's — and its callers open it through `navigation`, the one
 * sanctioned way to change what is shown. Nothing here writes context; the loader does that when
 * the URL changes.
 *
 * Every answer that is not an openable dock is the prompt (today's ask). That includes a box with
 * no decision API: there every answer is the prompt, so the magic line behaves exactly as before.
 */

import { TypeId } from '@sdk';
import { navigationDecision, type NavigationTarget } from '@sdk/decision';

import { AssetDocPointer } from '@src/navigation/AssetDocPointer';
import { editorForType } from '@src/navigation/asset-doc-types';
import { DockPointer } from '@src/navigation/DockPointer';
import { dockPointerForFile } from '@src/navigation/local-file-pointer';
import { tryParseDock } from '@src/navigation/try-parse-dock';
import { ViewType } from '@src/types/ViewType';

/** The dock a navigator target opens, or null when it addresses nothing openable here. */
export function dockForTarget(target: NavigationTarget): DockPointer | null {
  switch (target.kind) {
    case 'view':
      return tryParseDock(`/dock/${target.value}`);
    case 'entity': {
      const type = target.value.split('-', 1)[0];
      const editor = editorForType(type);
      return editor ? AssetDocPointer.forTypeId(editor, new TypeId(target.value)).toDockPointer() : null;
    }
    case 'file':
      return dockPointerForFile(target.value);
    case 'url':
      return DockPointer.forWebUrl(target.value);
    case 'webapp':
      return DockPointer.forWebUrl(`http://localhost:${target.value}`);
    case 'app':
      return new DockPointer(ViewType.APP, `artifact-${target.value}`);
    default:
      return null;
  }
}

export type NavigationDecision = { dock: DockPointer; prompt?: undefined } | { dock?: undefined; prompt: string };

/** What to do with `text`: a dock to navigate, or the prompt for the assistant. Never throws. */
export async function decideNavigation(text: string): Promise<NavigationDecision> {
  // Where the person is comes from this tab's own browser context, on the backend.
  const outcome = await navigationDecision(text);
  const dock =
    (outcome.address ? tryParseDock(outcome.address) : null) ??
    (outcome.decision.route === 'quick' && outcome.decision.target ? dockForTarget(outcome.decision.target) : null);
  return dock ? { dock } : { prompt: outcome.prompt ?? text };
}

/** The magic line: navigate to the decided dock, else ask the assistant the prompt. */
export async function askOrOpen(
  text: string,
  { open, ask }: { open: (dock: DockPointer) => void; ask: (prompt: string) => void },
): Promise<'opened' | 'asked'> {
  const decision = await decideNavigation(text);
  if (decision.dock) {
    open(decision.dock);
    return 'opened';
  }
  ask(decision.prompt);
  return 'asked';
}
