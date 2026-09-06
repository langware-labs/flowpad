import { capabilityManager, HARNESS_CAPABILITY_KINDS } from '@sdk';
import React, { useCallback, useState } from 'react';

import { AskInstallOneOfDialog } from './AskInstallOneOfDialog';

/**
 * "The harness is missing — do you want to install one?", as one dialog any
 * surface can raise.
 *
 * Two places discover a missing harness, by two unrelated routes: the terminal
 * strip's Start-<vendor> openers, and the vibe chat's first prompt. Both used
 * to end somewhere unhelpful — a silent redirect to the Capabilities view, and
 * a generic "Failed to start the build session" toast. The dialog that offers
 * "Try auto install" existed the whole time and only one of them could reach
 * it, because it was held in the strip controller's own state.
 *
 * `confirmMissingThen` is the important half. Neither caller can trust the
 * capability ROW it already has: the pre-flight reads a row that goes stale
 * (`ensureChecked` returns the moment any verdict exists), so a harness
 * uninstalled since the last discovery sweep still reads available and the
 * launch is the first thing to notice. `capabilityManager.test` re-runs
 * discovery for the kind, which both answers the question and rewrites the
 * stale row — so the failure decides what to show by ASKING, not by assuming.
 * The probe is paid for only on a path that has already failed.
 */
export interface HarnessInstallPrompt {
  /** Raise the dialog unconditionally (the caller already knows). */
  promptToInstall: () => void;
  /**
   * Re-probe `kind`; show the dialog if it really is missing, else hand control
   * back via `otherwise` so a failure with another cause is not mislabelled as
   * an uninstalled harness. A probe that itself fails takes `otherwise` too —
   * no answer is not the same as "it is missing".
   */
  confirmMissingThen: (kind: string, otherwise: () => void) => void;
  /** Render once in the host. */
  dialog: React.ReactNode;
}

export function useHarnessInstallPrompt(): HarnessInstallPrompt {
  const [kinds, setKinds] = useState<string[] | null>(null);

  const promptToInstall = useCallback(() => setKinds([...HARNESS_CAPABILITY_KINDS]), []);

  const confirmMissingThen = useCallback(
    (kind: string, otherwise: () => void) => {
      void capabilityManager
        .test(kind)
        .then((probe) => (probe.available ? otherwise() : promptToInstall()))
        .catch(otherwise);
    },
    [promptToInstall],
  );

  return {
    promptToInstall,
    confirmMissingThen,
    dialog: <AskInstallOneOfDialog kinds={kinds} onClose={() => setKinds(null)} />,
  };
}
