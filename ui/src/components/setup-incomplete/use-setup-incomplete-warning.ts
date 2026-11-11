import { isOk, type UserWarning, ViewType, WARNING_IDS, type WizardResult } from '@sdk';
import { useLingui } from '@lingui/react/macro';
import { useMemo } from 'react';

import { notify } from '@src/notifications';

import { openSetupWizard } from './open-setup-wizard';
import { useFirstRunWizard } from './use-first-run-wizard';

/**
 * Whether the first-run setup ended short of all green: a step failed, or a person declined or
 * cancelled one. A wizard that never ran has no result, and a run still in flight is not "ended" —
 * its partial writes are always NOT_YET (see `_report_progress`), so without `live` the warning
 * would flash on while setup is working.
 */
export function setupIncomplete(result: WizardResult | null | undefined, live: boolean): boolean {
  return Boolean(result) && !live && !isOk(result);
}

/**
 * The footer's "setup did not finish" warning, or `null` when setup is fine, still running, or has
 * never run. Derived from the first-run wizard's own last run, so it clears itself the moment a run
 * ends all green — nothing here is stored or dismissed.
 *
 * Its button is Settings → General → "Run setup again", the same function: the wizard popup opens
 * blank and the person presses Start.
 */
export function useSetupIncompleteWarning(): UserWarning | null {
  const { t } = useLingui();
  const { wizard, live } = useFirstRunWizard();

  const incomplete = setupIncomplete(wizard?.run_state?.result, live);

  return useMemo(() => {
    if (!incomplete) return null;
    const rerun = () => {
      void openSetupWizard()
        .then((opened) => {
          if (!opened) throw new Error(t`The setup wizard is not installed.`);
        })
        .catch((err: unknown) =>
          notify.error({
            title: t`Could not open setup`,
            message: err instanceof Error ? err.message : String(err),
            forceToast: true,
          }),
        );
    };
    return {
      id: WARNING_IDS.SETUP_INCOMPLETE,
      icon: 'AlertTriangle',
      color: 'yellow',
      message: t`Setup did not finish successfully`,
      description: t`An install failed or was cancelled, so Flowpad may be missing tools it needs.`,
      targetView: ViewType.HOME,
      onClick: rerun,
      action: { label: t`Run setup again`, onClick: rerun },
    } satisfies UserWarning;
  }, [incomplete, t]);
}
