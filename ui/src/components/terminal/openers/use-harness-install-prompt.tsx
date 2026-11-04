import { capabilityManager, HARNESS_CAPABILITY_KINDS } from '@sdk';
import React, { useCallback, useState } from 'react';


import { handleLaunchFailure } from '@src/components/launch-failure/LaunchFailureCard';

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
   * Route a failed launch to the screen that can repair it.
   *
   * Three outcomes, in the order a person can act on them:
   *  - a launch failure → the launch-failure card (its Try again runs `retry`);
   *  - the harness is genuinely missing → the install dialog;
   *  - anything else, or an unanswerable probe → `otherwise`, so a failure with
   *    another cause keeps its own explanation.
   */
  confirmMissingThen: (kind: string, error: unknown, otherwise: () => void, retry?: () => Promise<unknown>) => void;
  /** Render once in the host. */
  dialog: React.ReactNode;
}

/** `harness.<vendor>.cli` → the worker the sources page focuses on. Undefined
 *  for the umbrella kind, which the page reads as "whichever is first". */
function workerOfKind(kind: string): string | undefined {
  const vendor = kind.split('.')[1];
  return vendor ? WORKER_OF_VENDOR[vendor] : undefined;
}

const WORKER_OF_VENDOR: Record<string, string> = {
  claude: 'claude_code',
  codex: 'codex',
  copilot: 'copilot',
  opencode: 'opencode',
};

export function useHarnessInstallPrompt(): HarnessInstallPrompt {
  const [kinds, setKinds] = useState<string[] | null>(null);

  const promptToInstall = useCallback(() => setKinds([...HARNESS_CAPABILITY_KINDS]), []);

  const confirmMissingThen = useCallback(
    (kind: string, error: unknown, otherwise: () => void, retry?: () => Promise<unknown>) => {
      // Before the probe: an unfunded harness would probe as installed.
      // Resolve the umbrella FIRST — before either branch. `getSnapshot` is a
      // cached read, not a probe, and BOTH destinations need the concrete
      // harness: the sources page focuses on one, and the availability question
      // is about one. The vibe chat asks with the umbrella kind, so without
      // this it landed on "whichever harness is first" rather than the one that
      // just refused to start.
      //
      // `getSnapshot('harness').available` is a
      // `.some()` across every `harness.*` row — "at least one assistant on
      // this machine" — which is not the question. A box with Codex installed
      // and Claude missing answers `true` to the umbrella while the launch that
      // just failed was Claude's, so the toast fired and the install dialog
      // never appeared. `resolvedKind` is the concrete harness a launch would
      // actually use (the reference's target, or the kind itself when already
      // concrete), and a snapshot of THAT reports only its own verdict.
      const resolved = capabilityManager.getSnapshot(kind).resolvedKind ?? kind;

      if (retry && handleLaunchFailure(error, retry, workerOfKind(resolved))) return;

      void capabilityManager
        .test(resolved)
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
