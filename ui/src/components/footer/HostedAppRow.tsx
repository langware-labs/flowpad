import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { Project, WebApp, type HostedApp, type PageBrowser, type PagePresence } from '@sdk';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { cn } from '@src/lib/utils';
import { agenticProcessName } from '@src/navigation/agentic-process-open';
import { formatTimeAgo } from '@src/store/pending-actions-store';

const PROCESS_PREFIX = 'agentic_process-';

/** A browser family Flowpad has no name of its own for is shown by its own name. */
const OWN_NAME: Partial<Record<PageBrowser, string>> = { edge: 'Edge', firefox: 'Firefox', safari: 'Safari' };

function age(iso: string | null): string {
  return iso ? formatTimeAgo(Date.parse(iso)) : '';
}

/** One line of an app's open pages: which browser holds it, who opened it, the page. */
function ConnectionLine({ page }: { page: PagePresence }) {
  const { t } = useLingui();
  const browser =
    page.browser === 'flowpad'
      ? t`Flowpad tab`
      : page.browser === 'agent'
        ? t`Agent browser`
        : page.browser === 'chrome'
          ? t`Your Chrome`
          : (OWN_NAME[page.browser] ?? t`Browser`);
  const processId = page.opened_by.startsWith(PROCESS_PREFIX) ? page.opened_by.slice(PROCESS_PREFIX.length) : '';
  const opener = processId ? t`session ${agenticProcessName(processId) ?? processId.slice(0, 8)}` : t`you`;
  return (
    <div className="flex items-center gap-2 px-2 py-1 text-xs" data-testid="hosted-app-connection">
      <span className="min-w-0 flex-1 truncate">
        {browser} · {opener} · {page.path}
      </span>
      <span className="shrink-0 tabular-nums text-muted-foreground">{age(page.since)}</span>
    </div>
  );
}

/**
 * One app this machine serves now. A click opens it in place: where it runs, then one line per live
 * connection. Read-only — the row shows what the backend reported (`WebApp.hosted()`), it starts nothing.
 */
export function HostedAppRow({ app, open, onToggle }: { app: HostedApp; open: boolean; onToggle: (id: string) => void }) {
  const { t } = useLingui();
  const Icon = iconForType(WebApp.type);
  const count = app.connections.length;
  const connections = count === 0 ? t`no connections` : plural(count, { one: '# connection', other: '# connections' });
  const state = app.state === 'degraded' ? t`Degraded` : t`Running`;
  const project = app.project_id ? Project.getByIdFromCache<Project>(app.project_id) : null;
  const projectName = project?.getDisplayName() ?? project?.name ?? null;
  const where = [
    app.port ? `localhost:${app.port}` : t`Served by Flowpad`,
    app.pid ? `pid ${app.pid}` : null,
    projectName,
  ].filter(Boolean);

  return (
    <>
      <li className={cn('group flex items-center rounded pe-1 hover:bg-muted', open && 'bg-muted')} data-testid="hosted-app-row">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => onToggle(app.webapp_id)}
          className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-start text-sm"
        >
          <Icon className={cn('h-3.5 w-3.5 shrink-0', count > 0 ? 'text-green-400' : 'text-muted-foreground')} />
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{app.title}</div>
            <div className="truncate text-xs text-muted-foreground">
              {[state, app.port ? `:${app.port}` : null, connections].filter(Boolean).join(' · ')}
            </div>
          </div>
        </button>
        <span className="shrink-0 ps-1 text-xs tabular-nums text-muted-foreground">{age(app.since)}</span>
      </li>
      {open && (
        <li className="ms-4 border-s pb-1 ps-1" data-testid="hosted-app-details">
          <div className="truncate px-2 py-1 text-xs text-muted-foreground">{where.join(' · ')}</div>
          <div className="px-2 pb-0.5 pt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            <Trans>Connections</Trans>
          </div>
          {count === 0 ? (
            <div className="px-2 py-1 text-xs text-muted-foreground">
              <Trans>Nobody has it open</Trans>
            </div>
          ) : (
            app.connections.map((page, i) => <ConnectionLine key={`${page.since}:${i}`} page={page} />)
          )}
        </li>
      )}
    </>
  );
}
