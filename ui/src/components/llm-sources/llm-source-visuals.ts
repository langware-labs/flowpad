import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { LLMSourceAuthority, type LLMSource } from '@sdk';

/**
 * How a funding verdict LOOKS — one table, for every surface that shows one.
 *
 * Extracted when the Connections table grew harness rows: two screens now report
 * the same `LLMSource` and a second, hand-written ladder had already drifted from
 * this one on every authority — most damagingly on `proven`, the strongest verdict
 * the backend can issue, which the copy read as "nobody has asked". Same failure
 * the account badges had, and the same fix (`account/hub-status-visuals.ts`).
 *
 * `text` is a lazy {@link MessageDescriptor}: this map is module-level, so a `t`
 * macro here would freeze the boot locale. Resolve it at render with `i18n._`.
 */

/** Authority → dot. Keyed by the enum, so a new authority is a type error.
 *
 *  Proven and cached stay distinguishable on purpose: a probed device login is
 *  evidence; an endpoint we merely believe is reachable is not the same claim,
 *  and flattening them would let a caller treat an assumption as a fact. */
const AUTHORITY_DOT: Record<LLMSourceAuthority, string> = {
  [LLMSourceAuthority.Proven]: 'bg-emerald-400',
  [LLMSourceAuthority.Cached]: 'bg-emerald-400/50',
  [LLMSourceAuthority.Presumed]: 'bg-amber-400/70',
};

const UNKNOWN_DOT = 'bg-muted-foreground/40';

/**
 * The dot for one row.
 *
 * Ineligibility wins over authority, and that ordering is the whole point.
 * `_key_sources` reports `PROVEN` for a provider with NO key — correctly, since it
 * listed the store and an absence is as authoritative as a presence — so reading
 * authority alone put a confident green dot beside "no openrouter key is stored on
 * this machine" next to a disabled button. Authority says how much the answer is
 * worth; the dot has to say what the answer WAS.
 */
export function dotFor(source: LLMSource | undefined): string {
  if (!source || !source.eligible) return UNKNOWN_DOT;
  return AUTHORITY_DOT[source.authority] ?? UNKNOWN_DOT;
}

/**
 * The same verdict as one short word, for a surface with a column rather than a
 * list — the Connections table, where the backend's full sentence rides in the
 * title and the cell has room for one word.
 *
 * "Not checked" is a first-class answer, not a hedge: `Capability.login_state` is
 * not persisted, so "nobody has asked" is the COMMON state after any restart.
 */
export function sourceVisual(source: LLMSource | undefined): {
  text: MessageDescriptor;
  dot: string;
} {
  const dot = dotFor(source);
  if (!source) return { text: msg`Not checked`, dot };
  if (!source.eligible) return { text: msg`Signed out`, dot };
  if (source.authority === LLMSourceAuthority.Presumed) return { text: msg`Not checked`, dot };
  return { text: msg`Signed in`, dot };
}
