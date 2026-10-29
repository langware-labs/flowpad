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

  /** Applies one change per row, one after the other (a skip may stage a git deletion: never two at once);
   *  the last answer is the readiness that follows — except on the page, whose answer needs the Ready list
   *  and nodes, so it reads once after. */
  const change = useCallback(
    async (
      reqs: ProjectSetupRequirement[],
      call: (req: ProjectSetupRequirement) => Promise<ProjectReadiness | null>,
      failed: (name: string) => string,
    ) => {
      setBusy(new Set(reqs.map(rowKey)));
      let last: ProjectReadiness | null | undefined;
      for (const req of reqs) last = (await withNotify(() => call(req), failed(req.name))) ?? last;
      setBusy(NONE);
      if (includeReady) await load();
      else take(last);
    },
    [includeReady, take, load],
  );

  const skip = useCallback(
    (reqs: ProjectSetupRequirement[], scope: ProjectSetupSkipScope, failed: (name: string) => string) =>
      change(reqs, (req) => Project.skipSetup(projectId, req.typeid, scope, { name: req.name }), failed),
    [projectId, change],
  );

  const unskip = useCallback(
    (req: ProjectSetupRequirement, failed: string) =>
      change(
        [req],
        (r) => Project.unskipSetup(projectId, r.typeid, r.name),
        () => failed,
      ),
    [projectId, change],
  );

  return { readiness, busy, load, skip, unskip };
}
