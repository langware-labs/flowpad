import { LLMSourceAuthority, type LLMSource } from '@sdk';

/**
 * How a funding verdict LOOKS.
 *
 * Extracted when the Connections table grew harness rows, and a second,
 * hand-written ladder had already drifted from this one — most damagingly on
 * `proven`, the strongest verdict the backend can issue, which the copy read as
 * "nobody has asked". Those rows now draw a backend-composed `ConnectionSpec`
 * and the WORD they show is decided in Python, so only the dot is left here and
 * only this screen still draws one. The drift pin moved with the fold: it is
 * `test_a_probed_harness_reads_connected` in `tests/unit/test_connection_status.py`.
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
