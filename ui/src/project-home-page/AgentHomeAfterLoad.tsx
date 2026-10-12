import { useEffect, useState } from 'react';
import { Trans } from '@lingui/react/macro';
import { Agent } from '@sdk';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { homePageDock } from './project-home-page-redirect';

/** Mounted only after the provider gate is ready; retains the established resume-or-launch home behavior. */
export function AgentHomeAfterLoad({ asset, projectId }: { asset: string; projectId: string }) {
  const { navigation } = useDockNavigation();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void homePageDock({ asset, type: Agent.type }, projectId).then((dock) => {
      if (live && dock) navigation.openDock(dock);
    }).catch((cause: unknown) => {
      if (live) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { live = false; };
  }, [asset, projectId, navigation]);
  return <p className="p-8 text-sm" role={error ? 'alert' : 'status'}>{error || <Trans>Opening your agent…</Trans>}</p>;
}
