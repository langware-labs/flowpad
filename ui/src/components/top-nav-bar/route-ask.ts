/**
 * The magic line's fast path: open what was asked for, or hand it to the assistant as today.
 *
 * The backend navigator decides (`flow_sdk/core/navigator.py`); this file only turns its target
 * into a dock and opens it through `navigation` — the one sanctioned way to change what is
 * shown. Nothing here writes context; the loader does that when the URL changes.
 *
 * Every path that is not a confident, openable target falls through to `fallback` (today's
 * ask). That includes a box with no decision API: there the navigator answers `agentic` for
 * every request, so the magic line behaves exactly as it did before this existed.
 */

import { TypeId } from '@sdk';
import { navigatorRoute, type NavigationTarget } from '@sdk/decision';

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

export async function askOrOpen(
  text: string,
  {
    page,
    projectTypeId,
    open,
    fallback,
  }: {
    page: string;
    projectTypeId?: string | null;
    open: (dock: DockPointer) => void;
    fallback: () => void;
  },
): Promise<'opened' | 'asked'> {
  const answer = await navigatorRoute(text, { page, context: { CurrentProjectTypeId: projectTypeId } });
  const dock = answer.route === 'quick' && answer.target ? dockForTarget(answer.target) : null;
  if (dock) {
    open(dock);
    return 'opened';
  }
  fallback();
  return 'asked';
}
