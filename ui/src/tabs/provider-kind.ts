/**
 * Provider/display kind for a terminal chip — the key into the strip's
 * `PROVIDER_META` table AND the value denormalized onto `Tab.icon_key` at
 * creation. Single source of truth for the vendor→glyph rule, so the creation
 * side (ensure-tab-for-dock) and the render-time fallback (useTabs) can't drift.
 */
export type ProviderKind = 'shell' | 'claude' | 'codex' | 'copilot';

/** Map an AgenticProcess `worker_type` to its provider kind (shells use
 *  `'shell'` directly). Unset/unknown worker_type defaults to `'claude'` —
 *  that's what AgenticProcess.spawn produces. */
export function providerKindForWorkerType(workerType: string | null | undefined): ProviderKind {
  const wt = workerType?.toLowerCase() ?? '';
  if (wt === 'codex') return 'codex';
  if (wt === 'copilot') return 'copilot';
  return 'claude';
}
