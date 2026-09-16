/**
 * Canonical-target builders for dead/legacy dock routes (X9b).
 *
 * Two dock slugs are no longer real views but stay reachable via stale or
 * hand-typed URLs:
 *   - `/dock/skills`       — the standalone Skills view was folded into the
 *                            Assets browser; without a redirect it silently
 *                            falls through to the full Home dashboard.
 *   - `/dock/markdown/<id>`— a bare markdown pointer renders an empty
 *                            "No markdown file selected" state; the canonical
 *                            home is the asset editor addressed by TypeId.
 *
 * These builders produce the redirect target through the DockPointer /
 * AssetDocPointer grammar only — never hand-concatenated — so the URL stays in
 * lockstep with the one owner of that grammar. The router uses them in a
 * `<Navigate replace>` (mirroring `DevToDockRedirect`).
 */
import { TypeId, isTypeId } from '@sdk';
import { DockPointer } from './DockPointer';

/** `/dock/skills` → the Assets browser filtered to skills (`/dock/assets/list/skill`). */
export function skillsRedirectTarget(): string {
  return DockPointer.forAssetList('skill').toUrl();
}

/**
 * `/dock/markdown/<id>` → the canonical asset-editor URL for that markdown
 * entity (`/dock/assets/editor/markdown/typeid/markdown-<id>`), or `null` when
 * `<id>` can't form a valid markdown TypeId (the caller renders NotFound).
 *
 * `<id>` may arrive bare (`<uuid>`) or as a full `markdown-<uuid>` TypeId.
 */
export function markdownRedirectTarget(id: string | undefined): string | null {
  if (!id) return null;
  let typeId: TypeId;
  try {
    typeId = isTypeId(id) ? new TypeId(id) : new TypeId('markdown', id);
  } catch {
    return null;
  }
  if (typeId.type !== 'markdown') return null;
  return DockPointer.forAssetEditorByTypeId('markdown', typeId).toUrl();
}
