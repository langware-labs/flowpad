import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Trans } from '@lingui/react/macro';
import { Project, TypeId, type DependencyState } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Checkbox } from '@src/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { openProjectSetup } from '@src/components/project-setup/project-setup-store';
import { useEntity } from '@src/hooks/entity-hooks';
import { useContext } from '@src/hooks/useContext';
import { useProjectDependencies } from '@src/hooks/use-project-dependencies';
import { dependencySourceIcon } from '@src/components/assets/DependencyChips';

interface MissingDependenciesDialogProps {
  open: boolean;
  /** Required dependencies that are not here (`GET dependencies` → `warnings`). */
  warnings: DependencyState[];
  /** Closed by "Not now" (or Escape / the X). `dontShowAgain` is the checkbox. */
  onNotNow: (dontShowAgain: boolean) => void;
  /** "Fix…" — open the project's setup. */
  onFix: (dontShowAgain: boolean) => void;
}

/**
 * MissingDependenciesDialog — the project is open but a REQUIRED dependency is
 * not on this machine (missing, unreachable, invalid). Lists each with the
 * backend's reason, and offers the project setup to fix it.
 *
 * "Don't show again until Flowpad restarts" is a backend dismissal
 * (`dismiss-dependency-warning`), which is memory only — so the warning comes
 * back after a restart by construction, with nothing to clear here.
 */
export function MissingDependenciesDialog({ open, warnings, onNotNow, onFix }: MissingDependenciesDialogProps) {
  const [dontShow, setDontShow] = useState(false);
  useEffect(() => {
    if (open) setDontShow(false);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onNotNow(dontShow)}>
      <DialogContent className="sm:max-w-md" data-testid="missing-dependencies-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            <Trans>Missing dependencies</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>This project needs these dependencies, and they are not on this computer.</Trans>
          </DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-1.5">
          {warnings.map((dep) => {
            const Icon = dependencySourceIcon(dep.source);
            return (
              <li
                key={`${dep.via ?? ''}/${dep.name}`}
                className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/5 px-3 py-2 text-sm"
                data-testid="missing-dependency"
                data-dependency-name={dep.name}
                data-state={dep.state}
              >
                <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="flex min-w-0 flex-col">
                  <span className="font-medium">{dep.name}</span>
                  <span className="break-all font-mono text-[11px] text-muted-foreground">{dep.source}</span>
                  {dep.reason && <span className="text-xs text-muted-foreground">{dep.reason}</span>}
                </div>
              </li>
            );
          })}
        </ul>
        <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <Checkbox
            checked={dontShow}
            onCheckedChange={(v) => setDontShow(v === true)}
            data-testid="missing-dependencies-dont-show"
          />
          <Trans>Don't show again until Flowpad restarts</Trans>
        </label>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onNotNow(dontShow)} data-testid="missing-dependencies-not-now">
            <Trans>Not now</Trans>
          </Button>
          <Button onClick={() => onFix(dontShow)} data-testid="missing-dependencies-fix">
            <Trans>Fix…</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** How often the warnings are re-read while the backend is still resolving.
 *  A display refresh, not a wait: the dialog's decision waits for `resolving`
 *  to turn false, however long that takes. */
const RESOLVING_POLL_MS = 1000;

/** Warnings this page already put in front of the user and they closed with
 *  "Not now" (without dismissing them) — not raised again for the same project
 *  until the page reloads. A dismissal is the backend's to remember. */
const seenThisSession = new Set<string>();

const warningKey = (projectId: string, dep: DependencyState) => `${projectId}:${dep.via ?? ''}/${dep.name}`;

/** Test seam: forget what this page has shown. */
export function resetMissingDependenciesSeen(): void {
  seenThisSession.clear();
}

/**
 * Mounted once at the app root: watches the ACTIVE project's dependency
 * warnings and raises {@link MissingDependenciesDialog} when there are any.
 *
 * Opening a project starts a background resolve on the backend. While it runs
 * (`resolving`), `missing` may only mean "not fetched yet", so the dialog stays
 * closed and the warnings are re-read until the resolve is done — only then is
 * a warning a warning.
 */
export function MissingDependenciesDialogRoot() {
  const projectId = useContext().project?.id ?? null;
  const projectTypeId = useMemo(() => (projectId ? new TypeId(Project.type, projectId) : null), [projectId]);
  const { data: project } = useEntity<Project>(projectTypeId, { watch: true, enabled: !!projectTypeId });
  const { warnings, resolving, refetch } = useProjectDependencies(project);

  useEffect(() => {
    if (!resolving) return;
    const timer = setInterval(() => void refetch(), RESOLVING_POLL_MS);
    return () => clearInterval(timer);
  }, [resolving, refetch]);
  const [closedTick, setClosedTick] = useState(0);

  const pending = useMemo(
    () => (projectId && !resolving ? warnings.filter((w) => !w.dismissed && !seenThisSession.has(warningKey(projectId, w))) : []),
    // `closedTick` re-reads the module-level set after a close.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [warnings, projectId, resolving, closedTick],
  );

  const close = useCallback(
    async (dontShowAgain: boolean) => {
      if (!project || !projectId) return;
      const shown = pending;
      if (dontShowAgain) {
        // The backend remembers until it restarts; the refetch then reads the
        // warnings without them.
        // A dismissal that fails is still not shown again on this page.
        await Promise.all(
          shown.map((w) =>
            project.dismissDependencyWarning(w.name).catch(() => seenThisSession.add(warningKey(projectId, w))),
          ),
        );
        await refetch();
      } else {
        for (const w of shown) seenThisSession.add(warningKey(projectId, w));
      }
      setClosedTick((n) => n + 1);
    },
    [project, projectId, pending, refetch],
  );

  const fix = useCallback(
    async (dontShowAgain: boolean) => {
      if (!project || !projectId) return;
      // Fixing covers this round too: the setup dialog takes over from here.
      for (const w of pending) seenThisSession.add(warningKey(projectId, w));
      openProjectSetup({ projectId, projectName: project.name ?? '' });
      await close(dontShowAgain);
    },
    [project, projectId, pending, close],
  );

  return (
    <MissingDependenciesDialog
      open={pending.length > 0}
      warnings={pending}
      onNotNow={(d) => void close(d)}
      onFix={(d) => void fix(d)}
    />
  );
}
