import { LLMFundingKind, LLMSourceAuthority, LLMSourceOrigin, type LLMSource } from '@sdk';
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import { AlertCircle, Cloud, CircleUserRound, KeyRound, type LucideIcon } from 'lucide-react';

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


/**
 * What KIND of thing pays, as a glyph and a sentence.
 *
 * Keyed on `LLMFundingKind` — the kind of the ENDPOINT a verdict names — and never on
 * `Capability.auth_mode`. That distinction is the whole reason this table is here: `auth_mode`
 * is the preference the user *stated*, and the resolver may legitimately not have honoured it.
 * `HarnessLoginModal`'s `authBadge` still derives from the preference and is exactly the drift
 * this module's header describes; read the kind off
 * `LLMFundingStatus.endpoints[resolved.endpoint_typeid]` and a surface cannot lie.
 *
 * A total `Record` over the enum, like `AUTHORITY_DOT` above, so a fourth funding kind is a
 * type error here rather than a silently missing glyph.
 */
const KIND_GLYPH: Record<LLMFundingKind, { Icon: LucideIcon; className: string; label: MessageDescriptor }> = {
  [LLMFundingKind.Device]: {
    Icon: CircleUserRound,
    className: '',
    label: msg`Funded by your vendor subscription`,
  },
  [LLMFundingKind.ApiKey]: { Icon: KeyRound, className: '', label: msg`Funded by a stored API key` },
  [LLMFundingKind.Hub]: { Icon: Cloud, className: '', label: msg`Funded by a hub endpoint` },
};

/** What nothing-funds-this looks like. Amber, because it is the state that stops a spawn. */
export const NO_FUNDING_GLYPH = {
  Icon: AlertCircle,
  className: 'text-amber-500',
  label: msg`No LLM source funds this harness`,
};

/** The glyph for a funding kind, falling back to the refusal glyph for an unknown one. */
export function glyphForFundingKind(kind: string | undefined): typeof NO_FUNDING_GLYPH {
  return KIND_GLYPH[kind as LLMFundingKind] ?? NO_FUNDING_GLYPH;
}

/**
 * Which rung produced a verdict — the badge to show, and whether it takes the choice away.
 *
 * One table rather than two switches, for the same reason `KIND_GLYPH` is a `Record`: the two
 * questions are asked of the same enum and a new origin must not be able to answer one and
 * silently miss the other. They are genuinely independent — `User` earns a badge but is not
 * pinned — which is why the row carries both rather than one deriving the other.
 *
 * `Default` gets no badge on purpose: "the priority order picked it" is the ABSENCE of a
 * decision, and badging it would make every untouched box look configured.
 */
const ORIGIN: Record<LLMSourceOrigin, { badge: MessageDescriptor | null; pinned: boolean }> = {
  [LLMSourceOrigin.Process]: { badge: msg`process`, pinned: true },
  [LLMSourceOrigin.Project]: { badge: msg`project`, pinned: true },
  [LLMSourceOrigin.User]: { badge: msg`chosen by you`, pinned: false },
  [LLMSourceOrigin.Default]: { badge: null, pinned: false },
};

const NO_ORIGIN = { badge: null, pinned: false };

export function scopeBadgeFor(origin: string | undefined): MessageDescriptor | null {
  return (ORIGIN[origin as LLMSourceOrigin] ?? NO_ORIGIN).badge;
}

/** Whether a scope has taken the choice away, so a picker must not offer to change it. */
export function isScopePinned(origin: string | undefined): boolean {
  return (ORIGIN[origin as LLMSourceOrigin] ?? NO_ORIGIN).pinned;
}
