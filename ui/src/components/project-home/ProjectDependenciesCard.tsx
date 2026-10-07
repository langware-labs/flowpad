import React, { useCallback, useState } from 'react';
import { Download, Loader2, Package, RefreshCw, Trash2 } from 'lucide-react';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import type { DependencyState, Project } from '@sdk';
import { Button } from '@src/components/ui/button';
import { WikiButton } from '@src/components/wiki-tip';
import { DEPENDENCIES_WIKI } from '@src/components/assets/dependency-sources';
import {
  DependencyKindChip,
  DependencyStateChip,
  dependencySourceIcon,
} from '@src/components/assets/DependencyChips';
import { useProjectDependencies } from '@src/hooks/use-project-dependencies';
import { notify } from '@src/notifications';

interface ProjectDependenciesCardProps {
  project: Project;
}

/**
 * The project's dependencies (`flow.json`) on its home: each one with where it
 * stands on this machine. An optional one that is not installed offers Install
 * — optional dependencies are never fetched on their own. Renders nothing for
 * a project that declares none; adding one is the "Add dependency" tiles' job.
 */
export const ProjectDependenciesCard: React.FC<ProjectDependenciesCardProps> = ({ project }) => {
  const { t } = useLingui();
  const { dependencies, warnings, install, remove, resolve } = useProjectDependencies(project);
  // The row whose action is running (`<name>` for install/remove, '*' for a resolve).
  const [busy, setBusy] = useState<string | null>(null);

  const run = useCallback(
    async (key: string, action: () => Promise<unknown>, failure: string) => {
      setBusy(key);
      try {
        await action();
      } catch (err) {
        notify.error({ title: failure, message: err instanceof Error ? err.message : undefined });
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  if (dependencies.length === 0) return null;

  const own = (d: DependencyState) => !d.via;
  // Optional and not here: never installed, or an install that failed (the
  // backend then reports the failure state with its reason). Either way
  // Install is what brings it in — or retries.
  const installable = (d: DependencyState) => own(d) && !d.required && d.state !== 'ready';
  const notInstalled = dependencies.filter(installable).length;

  return (
    <div className="rounded-lg border border-border p-4" data-testid="project-dependencies-card">
      <div className="mb-3 flex items-center gap-2">
        <Package className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">
          <Trans>Dependencies</Trans>
        </h3>
        <WikiButton wikiword={DEPENDENCIES_WIKI} label={t`What is a dependency?`} />
        {warnings.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="ms-auto h-7 gap-1.5 text-xs"
            disabled={busy !== null}
            onClick={() => void run('*', () => resolve(), t`Could not fetch the dependencies`)}
            data-testid="dependency-resolve"
          >
            {busy === '*' ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            <Trans>Fetch missing</Trans>
          </Button>
        )}
      </div>
      {notInstalled > 0 && (
        <p className="mb-3 text-xs text-muted-foreground" data-testid="dependencies-not-installed">
          <Plural
            value={notInstalled}
            one="# optional dependency not installed"
            other="# optional dependencies not installed"
          />
        </p>
      )}
      <ul className="flex flex-col gap-1">
        {dependencies.map((dep) => {
          const Icon = dependencySourceIcon(dep.source);
          const rowBusy = busy === dep.name;
          const via = dep.via;
          return (
            <li
              key={`${dep.via ?? ''}/${dep.name}`}
              className="flex items-center gap-2 rounded-md border border-border/60 px-3 py-1.5 text-sm"
              data-testid="dependency-row"
              data-dependency-name={dep.name}
              data-state={dep.state}
            >
              <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">{dep.name}</span>
                <span className="truncate font-mono text-[11px] text-muted-foreground" title={dep.source}>
                  {via ? `${dep.source} · ${t`via ${via}`}` : dep.source}
                </span>
                {dep.state !== 'ready' && dep.reason && (
                  <span className="text-xs text-muted-foreground" data-testid="dependency-reason">
                    {dep.reason}
                  </span>
                )}
              </div>
              <DependencyStateChip dependency={dep} />
              <DependencyKindChip required={dep.required} />
              {installable(dep) && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 text-xs"
                  disabled={busy !== null}
                  onClick={() => void run(dep.name, () => install(dep.name), t`Could not install the dependency`)}
                  data-testid="dependency-install"
                >
                  {rowBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                  <Trans>Install</Trans>
                </Button>
              )}
              {own(dep) && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  disabled={busy !== null}
                  aria-label={t`Remove dependency`}
                  title={t`Remove dependency`}
                  onClick={() => void run(dep.name, () => remove(dep.name), t`Could not remove the dependency`)}
                  data-testid="dependency-remove"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
};
