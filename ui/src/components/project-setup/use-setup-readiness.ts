import { useCallback, useEffect, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import {
  Project,
  setProjectReadiness,
  type ProjectReadiness,
  type ProjectSetupRequirement,
  type ProjectSetupSkipScope,
} from '@sdk';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';
import { rowKey } from './setup-labels';

const NONE: ReadonlySet<string> = new Set();

/** Runs `fn`; a failure becomes an error toast titled from the error, else `fallback`. */
export async function withNotify<T>(fn: () => Promise<T>, fallback: string): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    notify.error({ title: errorMessage(e, fallback) });
    return undefined;
  }
}

/**
 * A project's setup readiness, as a screen shows it (the setup dialog, the setup page): read it, re-read it
 * after a run, skip and unskip a row. Every answer also goes to the footer's store (`setProjectReadiness`),
 * so one read serves both — never a second request for the same answer.
 *
 * `includeReady` (the page) also lists what is set up and each step's tree node. `enabled` false holds the
 * first read (a closed dialog reads nothing).
 */
export function useSetupReadiness(
  projectId: string,
  { includeReady = false, enabled = true }: { includeReady?: boolean; enabled?: boolean } = {},
) {
  const { t } = useLingui();
  const [readiness, setReadiness] = useState<ProjectReadiness | null>(null);
  const [busy, setBusy] = useState(NONE);

  const take = useCallback((next: ProjectReadiness | null | undefined) => {
    if (!next) return;
    setReadiness(next);
    setProjectReadiness(next);
  }, []);

  const load = useCallback(async () => {
    take(
      await withNotify(
        () => Project.setupRequirements(projectId, { includeReady }),
        t`Could not read the project's setup`,
      ),
    );
  }, [projectId, includeReady, take, t]);

  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);

  /** Skips each of `reqs`, one after the other; each answer is the readiness that follows. */
  const skip = useCallback(
    async (reqs: ProjectSetupRequirement[], scope: ProjectSetupSkipScope, failed: (name: string) => string) => {
      setBusy(new Set(reqs.map(rowKey)));
      for (const req of reqs)
        take(
          await withNotify(() => Project.skipSetup(projectId, req.typeid, scope, { name: req.name }), failed(req.name)),
        );
      setBusy(NONE);
      // The skip's own answer has no Ready list or nodes; the page reads them again.
      if (includeReady) await load();
    },
    [projectId, includeReady, take, load],
  );

  const unskip = useCallback(
    async (req: ProjectSetupRequirement, failed: string) => {
      setBusy(new Set([rowKey(req)]));
      take(await withNotify(() => Project.unskipSetup(projectId, req.typeid, req.name), failed));
      setBusy(NONE);
      if (includeReady) await load();
    },
    [projectId, includeReady, take, load],
  );

  return { readiness, busy, load, skip, unskip };
}
