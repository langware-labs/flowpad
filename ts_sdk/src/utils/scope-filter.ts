/**
 * Single source of truth for "which records does the user want to see".
 * Every UI surface (assets browser, records scanner, search bar) and every
 * API call ships this exact shape.
 *
 * The intent is carried EXPLICITLY by `mode`, not inferred from a combination of
 * boolean/array fields:
 *
 *  - `all`     — show everything (user + every project + unscoped types). No
 *                scope params are sent, so the backend applies no scope filter.
 *  - `user`    — user-scope records only (~/.claude/...).
 *  - `project` — exactly ONE project: `activeProjectId`. This is the "I'm working
 *                in this project" mode. A tab opened in this mode ATTACHES to
 *                `activeProjectId` (see `Tab.getFromDockPointer`).
 *  - `filter`  — an ad-hoc selection: `user` flag + a `projects` list. The
 *                multi-select / "Selected" mode. Not a single-project context, so
 *                a tab opened in this mode stays projectless (global).
 *
 * `project` vs a one-element `filter` produce the same RESULT set but carry
 * different intent — only `project` denotes an active-project context, and only
 * `project` attaches its tab to a project. That disambiguation is the whole point
 * of making `mode` first-class.
 *
 * Serialization onto a dock URL goes through `SCOPE_CODEC` (the `scope-<field>`
 * grammar) — see `scope-filter` ⇄ `url-object-codec`. The backend wire format
 * stays the canonical `user`/`projects` params (`applyScopeToParams`); every mode
 * projects losslessly down to an effective `(user, projects)` set there.
 */
import {
  type UrlObjectCodec,
  decodeUrlObject,
  encodeUrlObject,
  mergeUrlObject,
  registerUrlObject,
} from './url-object-codec';

export type ScopeMode = 'all' | 'user' | 'project' | 'filter';

export interface ScopeFilter {
  mode: ScopeMode;
  /** Authoritative iff `mode === 'project'`: the single project this scope pins. */
  activeProjectId?: string | null;
  /** Only meaningful in `mode === 'filter'`: include user-scope records. */
  user?: boolean;
  /** Only meaningful in `mode === 'filter'`: entity-ids of selected projects. */
  projects?: string[];
}

// ── constructors ────────────────────────────────────────────────────────────
// Build scopes through these, never via object literals at call sites, so the
// shape has one home.

export function allScope(): ScopeFilter {
  return { mode: 'all' };
}
export function userScope(): ScopeFilter {
  return { mode: 'user' };
}
export function projectScope(activeProjectId: string): ScopeFilter {
  return { mode: 'project', activeProjectId };
}
export function filterScope(user: boolean, projects: string[]): ScopeFilter {
  return { mode: 'filter', user, projects: [...projects] };
}

/** Show everything — the backend receives no scope params. */
export const ALL_SCOPE_FILTER: ScopeFilter = { mode: 'all' };

/**
 * The default a user-facing surface should land on. With a current project in
 * context, default to that project (`mode: 'project'`) so scan/index/list start
 * narrowest AND the opened tab attaches to the project. Project-less surfaces
 * (`null`/`undefined`) fall through to user scope.
 */
export function defaultScopeFilter(currentProjectId?: string | null): ScopeFilter {
  if (!currentProjectId) return userScope();
  return projectScope(currentProjectId);
}

// ── selectors ───────────────────────────────────────────────────────────────
// Read scope through these; never touch `.mode`/`.projects`/`.user` ad-hoc at a
// call site. They translate any mode into the effective question being asked.

/** True for the "everything, no filter" mode. */
export function isAllScope(sf: ScopeFilter): boolean {
  return sf.mode === 'all';
}

/** Does this scope include user-scope records? `all` includes everything. */
export function scopeIncludesUser(sf: ScopeFilter): boolean {
  switch (sf.mode) {
    case 'all':
    case 'user':
      return true;
    case 'project':
      return false;
    case 'filter':
      return !!sf.user;
  }
}

/**
 * The explicit project ids this scope selects. `all`/`user` select no specific
 * project (→ `[]`); `project` → `[activeProjectId]`; `filter` → its list.
 */
export function scopeProjectIds(sf: ScopeFilter): string[] {
  switch (sf.mode) {
    case 'project':
      return sf.activeProjectId ? [sf.activeProjectId] : [];
    case 'filter':
      return sf.projects ?? [];
    case 'all':
    case 'user':
      return [];
  }
}

/**
 * Does a record with the given `projectId` belong in `scope`? The client-side
 * mirror of the backend scope match, expressed via the selectors above:
 *   all → everything; no project → user-scope only; project → the one active
 *   project; filter → any selected project (+ personal when `user` is on).
 * `currentProjectId` is the fallback anchor when a `project` scope carries no
 * explicit `activeProjectId`.
 */
export function projectIdInScope(
  projectId: string | null | undefined,
  scope: ScopeFilter,
  currentProjectId: string | null,
): boolean {
  if (isAllScope(scope)) return true;
  if (!projectId) return scopeIncludesUser(scope);
  if (scope.mode === 'project') return projectId === (scope.activeProjectId ?? currentProjectId);
  return scopeProjectIds(scope).includes(projectId);
}

/** Equality on ScopeFilter (order-insensitive on `projects`). */
export function scopeFilterEqual(a: ScopeFilter, b: ScopeFilter): boolean {
  if (a.mode !== b.mode) return false;
  switch (a.mode) {
    case 'all':
    case 'user':
      return true;
    case 'project':
      return (a.activeProjectId ?? null) === (b.activeProjectId ?? null);
    case 'filter': {
      if (!!a.user !== !!b.user) return false;
      const ap = [...(a.projects ?? [])].sort();
      const bp = [...(b.projects ?? [])].sort();
      return ap.length === bp.length && ap.every((v, i) => v === bp[i]);
    }
  }
}

/**
 * Scopes that are matched by `project_id` (carry a project). Mirrors the
 * backend `PROJECT_LIKE_SCOPES` (flow_sdk/server/search_filters.py) — keep in
 * sync. System rows carry the system project's id, so they're surfaced by
 * selecting that project, exactly like ordinary project rows.
 */
export const PROJECT_LIKE_SCOPES = ['project', 'system'] as const;

/**
 * The scope "bucket" an opened asset belongs to: its project (project- or
 * system-scoped) or the user scope. Derived from the asset's `scope`/
 * `project_id`; `null` when the asset has no resolvable bucket.
 */
export type AssetScopeBucket = { projectId: string } | { user: true } | null;

/**
 * Resolve an asset's scope bucket from its `scope`/`project_id` fields. Used to
 * union the open asset's own scope into a side-menu filter (see
 * `unionAssetBucket`). Returns `null` when the asset has no resolvable bucket.
 */
export function assetScopeBucket(
  asset: { scope?: string | null; project_id?: string | null } | null | undefined,
): AssetScopeBucket {
  const scope = asset?.scope ?? '';
  const projectId = asset?.project_id ?? null;
  if (scope === 'user') return { user: true };
  if (projectId && (PROJECT_LIKE_SCOPES as readonly string[]).includes(scope)) {
    return { projectId };
  }
  return null;
}

/**
 * Union an opened asset's bucket onto a base ScopeFilter so the asset's own
 * type/count shows up in the side menu while you're viewing it. Returns the base
 * unchanged (same reference) when there's nothing to add — `all` already shows
 * everything, the bucket is empty, or it's already represented. Any genuine union
 * yields a `filter` scope (an ad-hoc combination); this drives display only, not
 * tab identity. Recompute per open; do not accumulate buckets across opens.
 */
export function unionAssetBucket(base: ScopeFilter, bucket: AssetScopeBucket): ScopeFilter {
  if (!bucket || isAllScope(base)) return base;
  const baseUser = scopeIncludesUser(base);
  const baseProjects = scopeProjectIds(base);
  const nextUser = baseUser || 'user' in bucket;
  const nextProjects = [...baseProjects];
  if ('projectId' in bucket && !nextProjects.includes(bucket.projectId)) {
    nextProjects.push(bucket.projectId);
  }
  if (nextUser === baseUser && nextProjects.length === baseProjects.length) return base;
  return filterScope(nextUser, nextProjects);
}

/** Stable key for React-Query and cache invalidation, and for assets tab identity. */
export function scopeFilterKey(sf: ScopeFilter): string {
  switch (sf.mode) {
    case 'all':
      return 'all';
    case 'user':
      return 'user';
    case 'project':
      return `project:${sf.activeProjectId ?? ''}`;
    case 'filter':
      return `filter:${sf.user ? '1' : '0'}:${[...(sf.projects ?? [])].sort().join(',')}`;
  }
}

/**
 * Serialize a ScopeFilter onto BACKEND-API URL search params: `?user=…&projects=…`.
 * Every mode projects down to its effective `(user, projects)` set here — this is
 * the one place the mode model meets the backend's canonical wire format
 * (flow_sdk/server/search_filters.py). `all` sends no params (no filter).
 *
 * Empty `projects` is sent as the empty string so the backend can distinguish
 * "filter present but empty" from "no filter".
 */
export function applyScopeToParams(params: URLSearchParams, scope: ScopeFilter): void {
  if (scope.mode === 'all') return; // everything: send no scope params
  params.set('user', scopeIncludesUser(scope) ? 'true' : 'false');
  params.set('projects', scopeProjectIds(scope).join(','));
}

/** Build a `?user=…&projects=…` query string from a ScopeFilter. */
export function scopeToQueryString(scope: ScopeFilter): string {
  const p = new URLSearchParams();
  applyScopeToParams(p, scope);
  return p.toString();
}

// ── dock-URL serialization (the `scope-<field>` grammar) ──────────────────────

/** UUID v4/v5 — the only legal entity-id versions (mirrors TypeId.ts / the
 *  entity-id non-negotiable). A URL-supplied `activeProjectId` must pass this
 *  before it's adopted; anything else is ignored. */
const ENTITY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The scope object's reserved URL-namespace slot. The `scope-<field>` grammar is
 * the ONE encoding of a scope filter in a dock URL; every dock goes through
 * `DockPointer.scopeFilter` / `withScopeFilter`, which delegate to the wrappers
 * below — no `scope`/`mode`/`projects` literals are parsed or built anywhere else.
 */
export const SCOPE_CODEC: UrlObjectCodec<ScopeFilter> = registerUrlObject<ScopeFilter>({
  ns: 'scope',
  encode(scope): Record<string, string> {
    switch (scope.mode) {
      case 'project':
        return { mode: 'project', activeProjectId: scope.activeProjectId ?? '' };
      case 'filter':
        return { mode: 'filter', user: String(!!scope.user), projects: (scope.projects ?? []).join(',') };
      case 'all':
      case 'user':
        return { mode: scope.mode };
    }
  },
  decode(fields): ScopeFilter | null {
    const mode = fields.mode as ScopeMode | undefined;
    switch (mode) {
      case 'all':
      case 'user':
        return { mode };
      case 'project': {
        const id = (fields.activeProjectId ?? '').trim();
        // Adopt-on-validate: a foreign/garbage id never becomes a scope anchor.
        return id && ENTITY_ID_RE.test(id) ? { mode, activeProjectId: id } : userScope();
      }
      case 'filter':
        return {
          mode,
          user: fields.user === 'true' || fields.user === '1',
          projects: (fields.projects ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0),
        };
      default:
        return null;
    }
  },
});

/** Serialize a ScopeFilter into dock-URL option keys (`scope-*`). */
export function scopeFilterToDockOptions(scope: ScopeFilter): Record<string, string> {
  return encodeUrlObject(SCOPE_CODEC, scope);
}

/** Merge `scope` into existing dock options, replacing any prior `scope-*` keys. */
export function withScopeFilterOptions(
  options: Record<string, string> | undefined,
  scope: ScopeFilter,
): Record<string, string> {
  return mergeUrlObject(SCOPE_CODEC, options, scope);
}

/** Parse dock options back into a ScopeFilter, or null when no `scope-*` key is set. */
export function dockOptionsToScopeFilter(
  options: Record<string, string> | undefined,
): ScopeFilter | null {
  return decodeUrlObject(SCOPE_CODEC, options);
}
