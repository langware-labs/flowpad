import { useState } from 'react';
import { ChevronRight, Loader2, Play } from 'lucide-react';
import type { OpenerDescriptor } from '@src/components/terminal/openers/tab_opener_types';
import { cn } from '@src/lib/utils';
import { useIsDev } from '@src/components/view-mode';
import { Trans, useLingui } from '@lingui/react/macro';
import { workerIcon, workerLabel } from '@src/components/lens-viewer/shared/transcript-features/transcript-utils';
import { LAUNCHABLE_WORKERS, type WorkerType } from '@src/components/workers/worker-types';
import { useLastWorkerType } from '@src/components/terminal/openers/useLastWorkerType';
import { useDefaultWorkerType } from '@src/contexts/HarnessCapabilitiesContext';

export type WorkerToolbarMode = 'lastOpened' | 'all';
export type WorkerToolbarVariant = 'icon-row' | 'menu-list';

/**
 * Canonical compact icon-button style for worker-launch surfaces. Shared so
 * sibling affordances (e.g. the markdown editor's Run button) sit inline with
 * the worker icons at the same size. Icons inside use `h-3.5 w-3.5`.
 */
export const WORKER_ICON_BUTTON_CLASS =
  'inline-flex h-7 w-7 items-center justify-center rounded border border-border text-foreground transition-colors hover:bg-muted disabled:opacity-50 aria-disabled:opacity-50';

/** Row style for the `menu-list` variant — shared by the vendor rows, the
 *  "More…" reveal, and the extra openers so they can't drift apart. */
const MENU_ITEM_CLASS =
  'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors hover:bg-muted disabled:opacity-50';

interface WorkerToolbarProps {
  /** Launch the chosen worker. The toolbar persists it as the last opener. */
  onLaunch: (worker: WorkerType) => void | Promise<void>;
  /** Single-session surfaces: when a process exists, show **Open** instead of the row. */
  hasProcess?: boolean;
  onOpen?: () => void;
  openTitle?: string;
  /** Disable launch buttons while a launch is in flight. */
  starting?: boolean;
  /**
   * Non-vendor spawn affordances to render after the workers, as the same
   * `OpenerDescriptor`s `useTerminalStripController` already builds (label,
   * icon, `pendingInline`, `disabled`). The project home passes `terminal` this
   * way: it isn't a coding-agent vendor, so it must stay out of
   * `LAUNCHABLE_WORKERS` (which every other surface renders) — the host opts in
   * per-surface instead. Adding sandbox/docker/history later costs no new prop.
   */
  extraOpeners?: OpenerDescriptor[];
  /**
   * Display mode. Defaults to `lastOpened` (only the last-used worker, others
   * behind a chevron), except in Dev view where it defaults to `all`. An
   * explicit prop always wins.
   */
  mode?: WorkerToolbarMode;
  /** `icon-row` (default) or `menu-list` (vertical labelled rows, e.g. the "+" menu). */
  variant?: WorkerToolbarVariant;
  testIdPrefix?: string;
}

/**
 * The single worker-launch affordance shared by every surface that offers
 * "start a worker (claude_code / codex / copilot)". Presentational + display-mode
 * logic only — the host owns the actual launch via `onLaunch` (and any project /
 * asset context it threads in there).
 *
 * Two render shapes:
 *   - `icon-row`   — square vendor icons (header toolbars, pickers);
 *   - `menu-list`  — full-width labelled rows ("Session — Claude", the "+" menu).
 *
 * Two display modes:
 *   - `all`        — every vendor (today's behavior; the Dev-view default);
 *   - `lastOpened` — the last-used vendor up front, the rest behind a chevron
 *                    (the standard-view default). Launching remembers the choice
 *                    in the shared last-opener key, so it surfaces first next time.
 */
export function WorkerToolbar({
  onLaunch,
  hasProcess = false,
  onOpen,
  openTitle = 'Open the session',
  starting = false,
  extraOpeners = [],
  mode,
  variant = 'icon-row',
  testIdPrefix = 'worker',
}: WorkerToolbarProps) {
  const { t } = useLingui();
  const isDev = useIsDev();
  const { lastWorker, rememberWorker } = useLastWorkerType();
  const defaultWorker = useDefaultWorkerType();
  const [expanded, setExpanded] = useState(false);

  const effectiveMode: WorkerToolbarMode = mode ?? (isDev ? 'all' : 'lastOpened');

  // The in-flight guard lives here (not on `disabled`) so a click during a
  // launch still reaches us and can say so in the console. A `disabled` button
  // dispatches no click event at all, which is exactly what made a stuck
  // `starting` flag look like "the button does nothing" with no trace anywhere.
  const launch = (worker: WorkerType) => {
    if (starting) {
      console.warn(
        `[WorkerToolbar] launch click IGNORED — a launch is already in flight (starting=true). ` +
          `worker=${worker} surface=${testIdPrefix}. If no session ever opens, the launch promise never settled.`,
      );
      return;
    }
    rememberWorker(worker);
    void onLaunch(worker);
  };

  if (hasProcess && onOpen) {
    return (
      <button
        type="button"
        onClick={onOpen}
        data-testid={`${testIdPrefix}-open-session`}
        className="inline-flex h-7 items-center gap-1.5 rounded border border-border px-2 text-xs font-medium text-foreground transition-colors hover:bg-muted"
        title={openTitle ?? t`Open the session`}
      >
        <Play className="h-3.5 w-3.5 text-orange-500" />
        <span>
          <Trans>Open</Trans>
        </span>
      </button>
    );
  }

  // In lastOpened mode, lead with the last worker (falling back to the
  // capability-selected default) and keep the rest behind the chevron. In all
  // mode, show everything.
  const primary: WorkerType = lastWorker ?? defaultWorker;
  const rest = LAUNCHABLE_WORKERS.filter((w) => w !== primary);
  const visibleWorkers: WorkerType[] = effectiveMode === 'all' || expanded ? [primary, ...rest] : [primary];
  const showChevron = effectiveMode === 'lastOpened' && !expanded && rest.length > 0;

  // Extra openers render from their descriptor in both variants — one source for
  // the label, glyph and in-flight spinner, so they match the vendor buttons.
  const renderExtra = (opener: OpenerDescriptor, menu: boolean) => {
    const Icon = opener.Icon;
    const size = menu ? 'h-3 w-3' : 'h-3.5 w-3.5';
    return (
      <button
        key={opener.id}
        type="button"
        onClick={opener.onActivate}
        disabled={opener.disabled}
        data-testid={`${testIdPrefix}-launch-${opener.id}`}
        title={menu ? undefined : opener.label}
        className={menu ? cn(MENU_ITEM_CLASS, 'text-foreground') : WORKER_ICON_BUTTON_CLASS}
      >
        {opener.pendingInline ? (
          <Loader2 className={cn(size, 'animate-spin')} />
        ) : (
          <Icon className={cn(size, opener.iconClassName)} />
        )}
        {menu && <span>{opener.label}</span>}
      </button>
    );
  };
  const availableExtras = extraOpeners.filter((o) => o.available);

  if (variant === 'menu-list') {
    return (
      <div className="flex flex-col" data-testid={`${testIdPrefix}-launch-menu`}>
        {visibleWorkers.map((worker) => {
          const Icon = workerIcon(worker);
          return (
            <button
              key={worker}
              type="button"
              onClick={() => launch(worker)}
              aria-disabled={starting}
              data-testid={`${testIdPrefix}-launch-${worker}`}
              className={cn(MENU_ITEM_CLASS, 'text-foreground', starting && 'opacity-50')}
            >
              <Icon className="h-3 w-3" />
              <Trans>Session — {workerLabel(worker)}</Trans>
            </button>
          );
        })}
        {showChevron && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            data-testid={`${testIdPrefix}-launch-more`}
            title={t`Show other workers`}
            className={cn(MENU_ITEM_CLASS, 'text-muted-foreground')}
          >
            <ChevronRight className="h-3 w-3" />
            <Trans>More…</Trans>
          </button>
        )}
        {availableExtras.map((o) => renderExtra(o, true))}
      </div>
    );
  }

  return (
    <div className="inline-flex items-center gap-1" data-testid={`${testIdPrefix}-launch-toolbar`}>
      {visibleWorkers.map((worker) => {
        const Icon = workerIcon(worker);
        return (
          <button
            key={worker}
            type="button"
            onClick={() => launch(worker)}
            aria-disabled={starting}
            data-testid={`${testIdPrefix}-launch-${worker}`}
            title={t`Start ${workerLabel(worker)}`}
            className={WORKER_ICON_BUTTON_CLASS}
          >
            <Icon className="h-3.5 w-3.5" />
          </button>
        );
      })}
      {showChevron && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          data-testid={`${testIdPrefix}-launch-more`}
          title={t`Show other workers`}
          className={cn(WORKER_ICON_BUTTON_CLASS, 'text-muted-foreground')}
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      )}
      {availableExtras.map((o) => renderExtra(o, false))}
    </div>
  );
}
