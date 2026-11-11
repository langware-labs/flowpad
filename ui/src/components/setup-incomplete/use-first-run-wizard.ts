import { type Wizard } from '@sdk';
import { isTerminal } from '@sdk/activity';
import { useContext, useEntity } from '@sdk/react/hooks';
import { useEffect, useState } from 'react';

import { pickLiveActivity, useActivitySpec } from '@src/store/activity-store';

import { findSetupWizard } from './open-setup-wizard';

/**
 * The first-run wizard on a desktop, watched, and whether a run of it is going right now — `undefined`
 * where it is not shipped (or not a desktop). A run in flight is not "ended": its partial writes are
 * always NOT_YET (see `_report_progress`), so a reader of its result asks `live` first.
 */
export function useFirstRunWizard(): { wizard: Wizard | undefined; live: boolean } {
  const { isDesktop } = useContext();
  // Found once: the wizard ships with the app, so its address never changes. A plain effect, not a
  // query — this runs in the footer, and needs nothing from the query cache.
  const [setup, setSetup] = useState<Wizard | undefined>();
  useEffect(() => {
    if (!isDesktop) return undefined;
    let cancelled = false;
    findSetupWizard()
      .then((found) => {
        if (!cancelled) setSetup(found);
      })
      .catch(() => {
        // Not found yet: no wizard to read — nothing to report as an error.
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
  return { wizard: (isDesktop && wizard) || undefined, live: Boolean(root && !isTerminal(root)) };
}
