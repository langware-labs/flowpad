import { PageId, isValidPage } from './ui/view-types';

/**
 * Runtime hub-mode — is the app serving ONLY the hub page?
 *
 * The same OSS build serves both the local desktop ("desk") and the cloud hub
 * ("hub"), differing only by API base + what the backend declares at bootstrap.
 * Against the hub, whose API is a strict SUBSET of the desktop `flow_sdk`,
 * desktop-only endpoints (`tab`, `capability`, `bookmark`, `assets/types`,
 * `cloud/status`, `toplog/state`, `@local` compute node, …) must be skipped to
 * avoid 404/422s.
 *
 * This stays keyed on `supported_pages` even though the backend now also
 * declares `runtime.kind`, because it is the signal that works against EVERY
 * hub including one too old to send a runtime. `dataContext.runtimeKind` folds
 * the two together (see context.ts) so the leaf and the context can never
 * disagree about what the hub is.
 *
 * LEAF module by design: it imports only `view-types` and holds the value in a
 * module-local, fed by `setSupportedPagesForHubMode` at bootstrap. It must NOT
 * import `dataContext`/entities — the SDK entity gates (`Tab`, `CapabilityManager`,
 * `Project`, …) import THIS, so a `dataContext` import would create an
 * entity→context→entity init cycle (APIEntity TDZ).
 */
// Cached once at bootstrap — `supported_pages` never changes after, so
// `isHubOnly()` (called behind many render + query gates) is a field read, not
// a re-filter/re-scan on every call.
let _isHubOnly = false;

// Readiness gate: the signal is unknown until bootstrap resolves, so any
// desktop-only probe that can fire during early init (service constructors,
// toplog seed) must `await hubModeReady()` BEFORE checking `isHubOnly()` — else
// it races ahead while the signal still reads its `[desk]` default and hits a
// non-existent hub endpoint (404). Resolves once, on the first
// set/mark call (always reached via initSdk's finally, even on bootstrap error).
let _resolved = false;
let _resolveReady!: () => void;
const _ready = new Promise<void>((resolve) => {
  _resolveReady = resolve;
});

function _markResolved(): void {
  if (!_resolved) {
    _resolved = true;
    _resolveReady();
  }
}

/** Called once at bootstrap (`dataContext.bootstrapInfo` assignment) with the
 *  server's `supported_pages`. Also unblocks `hubModeReady()`.
 *
 *  Mirrors `normalizeSupportedPages`: a missing/empty/unknown list falls back
 *  to `[desk]`, so hub-only is true ONLY when the server explicitly serves no
 *  desk. */
export function setSupportedPagesForHubMode(list: string[] | null | undefined): void {
  const known = (Array.isArray(list) ? list : []).filter(isValidPage);
  const pages = known.length > 0 ? known : [PageId.DESK];
  _isHubOnly = !pages.includes(PageId.DESK);
  _markResolved();
}

/** Unblock `hubModeReady()` without changing the pages — for initSdk exit paths
 *  where bootstrap never delivered a value (error / early config return). Leaves
 *  the `[desk]` fallback, i.e. desk behavior. */
export function markHubModeReady(): void {
  _markResolved();
}

/** Resolves once the hub-mode signal is known (bootstrap seeded it, or init
 *  finished without it). Early desktop-only probes await this before deciding. */
export function hubModeReady(): Promise<void> {
  return _ready;
}

/** True when the served backend serves no `desk` page (cached at bootstrap). */
export function isHubOnly(): boolean {
  return _isHubOnly;
}
