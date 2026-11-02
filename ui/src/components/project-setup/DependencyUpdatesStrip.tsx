import { useMemo, useState } from 'react';
import { Plural, Trans } from '@lingui/react/macro';
import { GitBranch, Loader2 } from 'lucide-react';
import { Project, recheckProjectReadiness, type DependencyState } from '@sdk';
import { Button } from '@src/components/ui/button';
import { useEntity } from '@src/hooks/entity-hooks/useEntity';
import { projectTypeId } from '@sdk/react/hooks/use-project-status';
import { useProjectDependencies } from '@src/hooks/use-project-dependencies';
import { cn } from '@src/lib/utils';

/** The branch a `git+<url>#<branch>` source asks for, if it names one. */
function branchOf(source: string): string {
  const hash = source.lastIndexOf('#');
  return hash >= 0 ? source.slice(hash + 1) : '';
}

/**
 * The top of the setup dialog while dependencies Flowpad cloned have updates waiting: one row per
 * dependency (how far behind, or why the last pull left it where it was) and one button that pulls
 * them all — the project's `resolve-dependencies` with `update`. Updates never block the project,
 * so this sits above the requirements, not among them. Absent when nothing is behind.
 */
export function DependencyUpdatesStrip({ projectId }: { projectId: string }) {
  const typeId = useMemo(() => projectTypeId(projectId), [projectId]);
  const { data: project } = useEntity<Project>(typeId, { watch: true });
  const { dependencies, resolve } = useProjectDependencies(project);
  const [pulling, setPulling] = useState(false);
  // A pull error is only ever reported on a dependency still behind, so "behind" is every row.
  const rows = useMemo(() => dependencies.filter((dep: DependencyState) => (dep.behind ?? 0) > 0), [dependencies]);
  if (!rows.length) return null;

  const pull = async () => {
    setPulling(true);
    try {
      await resolve({ update: true });
    } finally {
      setPulling(false);
      void recheckProjectReadiness();
    }
  };

  return (
    <section
      className="flex flex-col gap-2 rounded border border-blue-500/45 bg-blue-500/5 px-3 py-2"
      data-testid="project-setup-dependency-updates"
    >
      <div className="flex items-center gap-2 text-sm">
        <span className="flex-1 font-medium text-blue-600 dark:text-blue-400">
          <Plural value={rows.length} one="# dependency is behind" other="# dependencies are behind" />
        </span>
        <Button
          size="sm"
          className="bg-blue-500 text-white hover:bg-blue-600"
          disabled={pulling}
          onClick={() => void pull()}
          data-testid="project-setup-pull-dependencies"
        >
          {pulling && <Loader2 className="animate-spin" />}
          {pulling ? <Trans>Pulling…</Trans> : <Trans>Pull dependencies to latest</Trans>}
        </Button>
      </div>
      <ul className="flex flex-col gap-1">
        {rows.map((dep) => {
          const branch = branchOf(dep.source);
          const count = dep.behind ?? 0;
          return (
            <li
              key={`${dep.via ?? ''}/${dep.name}`}
              className="flex items-center gap-2 rounded border px-3 py-2 text-sm"
              data-testid={`project-setup-dependency-update-${dep.name}`}
            >
              <GitBranch className="size-4 shrink-0 text-muted-foreground" />
              <span className="font-medium">{dep.label || dep.name}</span>
              {branch && <span className="rounded-full border px-2 text-xs text-muted-foreground">{branch}</span>}
              <div className="flex-1" />
              <span
                className={cn(
                  'flex items-center gap-1 text-xs',
                  dep.pull_error && !pulling
                    ? 'text-yellow-600 dark:text-yellow-400'
                    : 'text-blue-600 dark:text-blue-400',
                )}
              >
                {pulling && count > 0 ? (
                  <>
                    <Loader2 className="size-3 animate-spin" />
                    <Trans>Pulling…</Trans>
                  </>
                ) : dep.pull_error ? (
                  dep.pull_error
                ) : (
                  <Plural value={count} one="# commit behind" other="# commits behind" />
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
