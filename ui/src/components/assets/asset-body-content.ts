/**
 * Which "nothing selected" surface the assets body shows, once the
 * editor/list/folder branches have been ruled out.
 *
 * The order matters and is the whole point: the never-indexed **Build Index**
 * prompt must not preempt the **project-home** landing. The prompt is for
 * "you're browsing assets and nothing is indexed"; project home is a landing of
 * its own that happens to be hosted by the assets body. When the rails project
 * icon opens `/dock/assets/project-home`, the index status is read UNSCOPED
 * (global) — so on a fresh instance `neverIndexed` is true and, without this
 * guard, the prompt hid project home entirely (only in Advanced view, since the
 * prompt is Advanced-only). See AssetsPage's render chain.
 */
export function shouldShowIndexPrompt(args: {
  neverIndexed: boolean;
  isAdvanced: boolean;
  isProjectHomeMode: boolean;
}): boolean {
  const { neverIndexed, isAdvanced, isProjectHomeMode } = args;
  // Project home always wins over the build prompt — it is a real surface, not
  // an "empty" state.
  return neverIndexed && isAdvanced && !isProjectHomeMode;
}
