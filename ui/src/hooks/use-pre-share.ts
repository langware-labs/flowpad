import { useCallback, useEffect, useState } from 'react';
import { ActionInfo, dataManager, type TypeId } from '@sdk';

/** A type's answer to "is anything needed before this is shared?" (`pre_share` action). */
export interface PreShareAnswer {
  needed: boolean;
  /** Which step the type wants shown (`credential_values`: whether, and how, a credential's values go too). */
  kind?: string;
  title?: string;
  detail?: string;
  project_id?: string;
  /** The entity's own name (a credential's, to publish its values). */
  name?: string;
  /** `credential_values`: the credential's typeid, to seal its values (secured transfer). */
  typeid?: string;
  /** `credential_values`: stored variables not yet published to a vault. */
  unpublished?: string[];
  /** `secret_vault`: the project's vault names already declared (empty: none). */
  vaults?: string[];
}

/**
 * The generic pre-share handler, asked once per open. `answered` is false while in flight; a
 * failed ask answers `needed: false` — a check never blocks a share. `recheck` asks again after
 * the step changed what was asked about.
 */
export function usePreShare(ref: TypeId | undefined, enabled: boolean) {
  const [answer, setAnswer] = useState<PreShareAnswer | null>(null);
  const [nonce, setNonce] = useState(0);
  const recheck = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    setAnswer(null);
    if (!enabled || !ref) return;
    let live = true;
    const action = new ActionInfo('pre_share', ref.type, ref.id, 'GET');
    void dataManager
      .callAction<unknown, PreShareAnswer>(action)
      .then((res) => live && setAnswer(res ?? { needed: false }))
      .catch(() => live && setAnswer({ needed: false }));
    return () => {
      live = false;
    };
  }, [ref?.toString(), enabled, nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  return { answered: !ref || !enabled || answer !== null, answer, recheck } as const;
}
