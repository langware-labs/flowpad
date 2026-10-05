import { isOk, type UserWarning, ViewType, WARNING_IDS, type Wizard, type WizardResult } from '@sdk';
import { isTerminal } from '@sdk/activity';
import { useContext, useEntity } from '@sdk/react/hooks';
import { useLingui } from '@lingui/react/macro';
import { useEffect, useMemo, useState } from 'react';

import { notify } from '@src/notifications';
import { pickLiveActivity, useActivitySpec } from '@src/store/activity-store';

import { findSetupWizard, openSetupWizard } from './open-setup-wizard';

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
  const { isDesktop } = useContext();
  // Found once: the wizard ships with the app, so its address never changes. A plain effect, not a
  // query — this hook runs in the footer, and needs nothing from the query cache.
  const [setup, setSetup] = useState<Wizard | undefined>();
  useEffect(() => {
    if (!isDesktop) return undefined;
    let cancelled = false;
    findSetupWizard()
      .then((found) => {
        if (!cancelled) setSetup(found);
      })
      .catch(() => {
        // Not found yet: no wizard to read, so no warning — nothing to report as an error.
      });
    return () => {
      cancelled = true;
    };
  }, [isDesktop]);
  const { data: wizard } = useEntity<Wizard>(setup?.typeId ?? null, { watch: true, enabled: Boolean(setup) });

  // The same two nodes `useWizardRun` reads: an attended run scopes its activity to the wizard,
  // the first-run trigger's unattended one to nothing. Whichever is live wins.
  const path = wizard?.activity_path ?? '';
  const scoped = useActivitySpec(path, wizard?.typeId.toString());
  const unattended = useActivitySpec(path, undefined);
  const root = pickLiveActivity(scoped, unattended);
  const live = Boolean(root && !isTerminal(root));

  const incomplete = isDesktop && setupIncomplete(wizard?.run_state?.result, live);

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
