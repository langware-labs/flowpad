import type { SecretOriginLocator, SodStore } from '@sdk';

/**
 * The secret origin kinds, as data. One table, two surfaces (the Credentials
 * screen's Project Environment tab and ProjectHome's Secrets card) — this file
 * exists so the two cannot drift.
 *
 * No labels here: a module-level string map escapes lingui extraction. Labels
 * live in `useSecretOriginLabel()` (OriginChip.tsx).
 *
 * `offered` and `provideable` are two different questions and both are load-bearing:
 *  - `offered`   — may a user pick this kind when declaring? gcp/1password are
 *                  stub drivers (`ProviderStubDriver`), so they are not offered.
 *                  They still RENDER, because a declaration can arrive from a
 *                  shared project authored somewhere that has them.
 *  - `provideable` — does `provide-secret` accept a value for this kind? Only the
 *                  two local stores. `flowpad-hub` refuses with
 *                  `SecretProvideUnsupported`, so its declaration is value-free
 *                  and the row reads Missing until the hub holds the value.
 */
export interface SecretOriginKindSpec {
  kind: SecretOriginLocator['kind'];
  /** The locator field that carries the primary coordinate for this kind. */
  coordField: string;
  defaultStore: SodStore;
  offered: boolean;
  provideable: boolean;
}

export const SECRET_ORIGIN_KINDS: readonly SecretOriginKindSpec[] = [
  { kind: 'local', coordField: 'sod_name', defaultStore: 'sodot', offered: true, provideable: true },
  { kind: 'env-local', coordField: 'env_key', defaultStore: 'env-local', offered: true, provideable: true },
  { kind: 'flowpad-hub', coordField: 'secret_id', defaultStore: 'sodot', offered: true, provideable: false },
  { kind: 'gcp', coordField: 'secret', defaultStore: 'sodot', offered: false, provideable: false },
  { kind: '1password', coordField: 'item', defaultStore: 'sodot', offered: false, provideable: false },
];

/** The kinds the declare dialog offers. Never render off this — render off the row. */
export const OFFERED_ORIGIN_KINDS = SECRET_ORIGIN_KINDS.filter((k) => k.offered);

/** `undefined` for a kind this build has never heard of — callers must cope
 *  rather than branch, so a new backend kind needs no frontend release. */
export function originKindSpec(kind: string | undefined): SecretOriginKindSpec | undefined {
  return SECRET_ORIGIN_KINDS.find((k) => k.kind === kind);
}

/** The default origin when the declarer does not choose one. */
export const DEFAULT_ORIGIN_KIND: SecretOriginLocator['kind'] = 'local';

/** The synthetic origin kind for OAuth rows. Deliberately NOT a
 *  `SecretOriginLocator['kind']` — an OAuth credential is not a declaration; this
 *  is only how it takes part in one Origin column. It lives here, with the other
 *  kind data, so `secrets/` never has to reach back into a screen that uses it. */
export const OAUTH_ORIGIN_KIND = 'oauth';
