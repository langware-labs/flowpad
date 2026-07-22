/**
 * Resolve an interface block's `source` pointer to a local file path.
 *
 * An origin is a *locator*, not a path: git coordinates name a repo, not a
 * checkout on this machine. Turning one into something the editor can open is
 * therefore a lookup with several ways to fail, and every failure has to come
 * back with a reason — a dead "Open in editor" button that says nothing is
 * worse than no button at all.
 *
 * Pure on purpose: no DOM, no navigation, no hooks. The caller supplies the
 * project lookups, so the whole resolution matrix is unit-testable.
 */

import { formatGitOrigin, isLocalOrigin, isSafeRelPath, type FSOriginField } from '@sdk';
import { normalizePath } from '@src/components/asset-manager/asset-row-helpers';
import type { InterfaceSource } from './interface-schema';

export interface SourceResolveContext {
  /** Root of the project the *document* lives in, or null if there is none. */
  documentProjectRoot: string | null;
  /** Root of a project by id — null when no such project is known locally. */
  projectRootById: (projectId: string) => string | null;
}

export type SourceLocation =
  | { ok: true; path: string; line?: number }
  | { ok: false; reason: string };

/** The root an origin's `rel_path` is relative to, or a reason it has none. */
function resolveRoot(
  origin: FSOriginField,
  ctx: SourceResolveContext,
): { ok: true; root: string } | { ok: false; reason: string } {
  // An explicit project wins over anything inferred: it is the one part of the
  // locator that names a place on *this* machine.
  if (origin.project_id) {
    const root = ctx.projectRootById(origin.project_id);
    if (!root) return { ok: false, reason: `No local project ${origin.project_id}` };
    return { ok: true, root };
  }

  if (isLocalOrigin(origin)) {
    if (!origin.base) return { ok: false, reason: 'Local origin has no base path' };
    return { ok: true, root: origin.base };
  }

  // Git coordinates alone can't name a checkout, so fall back to the repo the
  // document itself lives in — the same-repo case this feature exists for.
  if (!ctx.documentProjectRoot) {
    return { ok: false, reason: 'No project open to resolve this origin against' };
  }
  return { ok: true, root: ctx.documentProjectRoot };
}

export function resolveSourceLocation(
  source: InterfaceSource,
  ctx: SourceResolveContext,
): SourceLocation {
  const { origin, line } = source;

  // Re-checked here as well as at parse time: this function is the last gate
  // before a path reaches navigation, and it is callable independently.
  if (!isSafeRelPath(origin.rel_path)) {
    return { ok: false, reason: `Unsafe path "${origin.rel_path}"` };
  }

  const root = resolveRoot(origin, ctx);
  if (!root.ok) return root;

  const base = normalizePath(root.root);
  const rel = normalizePath(origin.rel_path).replace(/^\//, '');
  if (!base) return { ok: false, reason: 'Origin resolved to an empty root path' };

  return { ok: true, path: `${base}/${rel}`, line };
}

/**
 * Human label for the provenance line: where this contract came from.
 *
 * Git origins reuse the SDK's own `formatGitOrigin` so the chip reads the same
 * here as everywhere else provenance is shown.
 */
export function formatSourceLabel(source: InterfaceSource): string {
  const { origin, line } = source;
  const label = isLocalOrigin(origin)
    ? [origin.base, origin.rel_path].filter(Boolean).join('/')
    : formatGitOrigin(origin);
  return line ? `${label}:${line}` : label;
}
