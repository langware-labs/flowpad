import type { FSRef } from '@sdk';
import { searchRecords, type SearchResult } from '@sdk/services/search-service';
import { basename, normalizePath } from '@src/components/asset-manager/asset-row-helpers';
import { DockPointer } from '@src/navigation/DockPointer';
import { resultTypeId } from '@src/navigation/record-type-nav';

/** Where a relative markdown link leads: a place to open, or files to suggest. */
export type SmartLinkAnswer =
  | { kind: 'open'; pointer: DockPointer }
  | { kind: 'suggest'; name: string; results: SearchResult[] };

/** The markdown editor for a search result, or null when it has no usable id. */
export function pointerForResult(r: SearchResult): DockPointer | null {
  const typeId = resultTypeId(r);
  return typeId ? DockPointer.forAssetEditorByTypeId('markdown', typeId) : null;
}

/**
 * Resolve a relative link from the document `from`.
 *
 * Fast lane: the path, relative to the document's own folder, when the document
 * lives on a compute node and the target file exists there.
 * Slow lane: search records by the link's file name. One file with that exact
 * name opens directly; anything else is offered as suggestions.
 */
export async function resolveSmartLink(from: FSRef, href: string, assetType: string): Promise<SmartLinkAnswer> {
  const rel = decodeURIComponent(href.split(/[?#]/)[0]);
  if (from.localComputeNodeId) {
    const target = from.parent.resolve(rel);
    if (await target.exists()) {
      return { kind: 'open', pointer: DockPointer.forAssetEditor(assetType, `/${target.path}`) };
    }
  }

  const file = basename(rel);
  const { results } = await searchRecords(file.replace(/\.md$/i, ''), { record_type: 'markdown', limit: 20 });
  const exact = results.filter(
    (r) => (r.asset_ref ? basename(normalizePath(r.asset_ref)) : `${r.name}.md`).toLowerCase() === file.toLowerCase(),
  );
  const only = exact.length === 1 ? pointerForResult(exact[0]) : null;
  if (only) return { kind: 'open', pointer: only };
  return { kind: 'suggest', name: file, results: exact.length ? exact : results.slice(0, 8) };
}
