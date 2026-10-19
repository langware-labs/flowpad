/**
 * DebugMenu — the one debug control of the session top bar, shown on the
 * terminal surface only. Sections: the vendor's CLI launch flags (written
 * straight to the entity), the terminal gutters, and the raw-stream viewers.
 */

import { AgenticProcess, Shell } from '@sdk';
import { isProcessRunning } from '@sdk/process/agentic-types.js';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@src/components/ui/dropdown-menu';
import { Bug, ExternalLink } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { PTYViewer } from './pty-viewer';
import { PTYEventsViewer } from './pty-events-viewer';
import { CommandStatusViewer } from './command-status-viewer';
import type { ColVisibility, TraceFilters } from './InteractiveTerminal';
import { getWorkerCliCapabilities } from './process-cli-presentation';

interface DebugMenuProps {
  process: AgenticProcess;
  traceFilters: TraceFilters;
  onTraceFiltersChange: (f: TraceFilters) => void;
  colVis: ColVisibility;
  onColVisChange: (v: ColVisibility) => void;
  /** Shell entity for the PTY viewers. */
  shell?: Shell | null;
}

type TimeField = 'time' | 'index' | 'line' | 'absLine' | 'debugTime' | 'refTime';

export function DebugMenu({
  process,
  traceFilters,
  onTraceFiltersChange,
  colVis,
  onColVisChange,
  shell,
}: DebugMenuProps) {
  const { t, i18n } = useLingui();
  const [showPtyViewer, setShowPtyViewer] = useState(false);
  const [showPtyEventsViewer, setShowPtyEventsViewer] = useState(false);
  const [showCommandStatus, setShowCommandStatus] = useState(false);

  // CLI flags can only be changed while the process is live.
  const canToggle = isProcessRunning(process.status);
  const cliCapabilities = getWorkerCliCapabilities(process.worker_type);
  const _cliOpts = process.cliOptions;
  const currentChrome = cliCapabilities.chrome && _cliOpts.chrome;
  const currentDanger = cliCapabilities.fullTrust && _cliOpts.permission_mode === 'bypassPermissions';
  const currentDebug = cliCapabilities.debug && _cliOpts.debug;
  const hasCliOptions = cliCapabilities.chrome || cliCapabilities.fullTrust || cliCapabilities.debug;
  // Vendor knowledge lives in the capabilities table; render its lazy descriptor here.
  const fullTrustDescription = cliCapabilities.fullTrustDescription ? i18n._(cliCapabilities.fullTrustDescription) : '';

  const persistCliFlags = async (overrides: { chrome?: boolean; danger?: boolean; debug?: boolean }) => {
    if (!canToggle) return;
    const cli = process.cliOptions;
    if (overrides.chrome !== undefined) cli.chrome = overrides.chrome;
    if (overrides.danger !== undefined) cli.permission_mode = overrides.danger ? 'bypassPermissions' : 'askUser';
    if (overrides.debug !== undefined) cli.debug = overrides.debug;
    process.cliOptions = cli;
    await process.save();
  };

  const timeFields: [TimeField, string][] = [
    ['time', t`Time`],
    ['index', t`Index (seq)`],
    ['line', t`Line`],
    ['absLine', t`Abs line`],
    ['debugTime', t`Row time range`],
    ['refTime', t`Anchor time range`],
  ];
  const anyCliActive = currentChrome || currentDanger || currentDebug;
  const anyTimeFieldActive = timeFields.some(([key]) => traceFilters[key]);
  const anyColActive = !colVis.trace || !colVis.time || !colVis.annotations || anyTimeFieldActive;

  return (
    <>
      {/* Non-modal: the viewers are dialogs. A modal menu locks `body`
          (pointer-events: none) while it is still closing, the dialog opening on
          top records that lock as the page's own, and restores it on close —
          leaving the whole app unclickable until a reload. */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            className={`inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded transition-colors hover:bg-accent ${
              anyCliActive
                ? 'text-amber-500 dark:text-amber-400'
                : anyColActive
                  ? 'text-primary'
                  : 'text-muted-foreground'
            }`}
            aria-label={t`Debug`}
            title={t`Debug — CLI options, gutters, viewers`}
            data-testid="process-toolbar-debug"
          >
            <Bug className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          {hasCliOptions && (
            <>
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                <Trans>CLI Options</Trans>
              </DropdownMenuLabel>
              {cliCapabilities.chrome && (
                <RichCheckboxItem
                  checked={currentChrome}
                  disabled={!canToggle}
                  onCheckedChange={(v) => void persistCliFlags({ chrome: v })}
                  label={t`Chrome browser`}
                  description={t`Enable browser automation via Chrome (--chrome)`}
                  docsUrl="https://docs.anthropic.com/en/docs/claude-code/cli-reference"
                />
              )}
              {cliCapabilities.fullTrust && (
                <RichCheckboxItem
                  checked={currentDanger}
                  disabled={!canToggle}
                  onCheckedChange={(v) => void persistCliFlags({ danger: v })}
                  label={t`Full Trust`}
                  description={fullTrustDescription}
                  docsUrl={cliCapabilities.fullTrustDocsUrl}
                />
              )}
              {cliCapabilities.debug && (
                <RichCheckboxItem
                  checked={currentDebug}
                  disabled={!canToggle}
                  onCheckedChange={(v) => void persistCliFlags({ debug: v })}
                  label={t`Debug logging`}
                  description={t`Verbose debug output (--debug)`}
                  docsUrl="https://docs.anthropic.com/en/docs/claude-code/cli-reference"
                />
              )}
              <DropdownMenuSeparator />
            </>
          )}

          <DropdownMenuLabel className="text-xs text-muted-foreground">
            <Trans>Gutters</Trans>
          </DropdownMenuLabel>
          <GutterItem
            checked={colVis.trace && traceFilters.events}
            onCheckedChange={(v) => {
              if (v) {
                onColVisChange({ ...colVis, trace: true });
                onTraceFiltersChange({ ...traceFilters, events: true });
              } else {
                onColVisChange({ ...colVis, trace: false });
              }
            }}
            label={<Trans>Trace events</Trans>}
            description={<Trans>— show trace event gutter</Trans>}
          />
          <GutterItem
            checked={colVis.time}
            onCheckedChange={(v) => onColVisChange({ ...colVis, time: v })}
            label={<Trans>Time gutter</Trans>}
            description={<Trans>— show time/index gutter</Trans>}
          />
          <GutterItem
            checked={colVis.annotations}
            onCheckedChange={(v) => onColVisChange({ ...colVis, annotations: v })}
            label={<Trans>Annotations</Trans>}
            description={<Trans>— show annotation gutter</Trans>}
          />
          <GutterItem
            checked={traceFilters.promptAnnotations}
            onCheckedChange={(v) => onTraceFiltersChange({ ...traceFilters, promptAnnotations: v })}
            label={<Trans>Prompt annotations</Trans>}
            description={<Trans>— show prompt anchors in gutter</Trans>}
          />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className={`text-xs ${anyTimeFieldActive ? 'text-primary' : ''}`}>
              <Trans>Time Gutter Fields</Trans>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-48">
              {timeFields.map(([key, label]) => (
                <DropdownMenuCheckboxItem
                  key={key}
                  className="text-xs"
                  checked={traceFilters[key]}
                  onSelect={(e) => e.preventDefault()}
                  onCheckedChange={(v) => onTraceFiltersChange({ ...traceFilters, [key]: v })}
                >
                  {label}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            <Trans>Viewers</Trans>
          </DropdownMenuLabel>
          <DropdownMenuItem className="text-xs" onSelect={() => setShowPtyViewer(true)}>
            <Trans>PTY Viewer</Trans>
          </DropdownMenuItem>
          <DropdownMenuItem className="text-xs" onSelect={() => setShowPtyEventsViewer(true)}>
            <Trans>PTY Events Viewer</Trans>
          </DropdownMenuItem>
          <DropdownMenuItem className="text-xs" onSelect={() => setShowCommandStatus(true)}>
            <Trans>Command Status</Trans>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <PTYViewer open={showPtyViewer} onClose={() => setShowPtyViewer(false)} shell={shell ?? null} />
      <PTYEventsViewer open={showPtyEventsViewer} onClose={() => setShowPtyEventsViewer(false)} shell={shell ?? null} />
      <CommandStatusViewer open={showCommandStatus} onClose={() => setShowCommandStatus(false)} process={process} />
    </>
  );
}

/** A gutter toggle that stays open on click, so several can be flipped in a row. */
function GutterItem({
  checked,
  onCheckedChange,
  label,
  description,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  label: ReactNode;
  description: ReactNode;
}) {
  return (
    <DropdownMenuCheckboxItem checked={checked} onSelect={(e) => e.preventDefault()} onCheckedChange={onCheckedChange}>
      <span className="text-xs">
        <span className="font-medium">{label}</span>
        <span className="ms-1 text-muted-foreground">{description}</span>
      </span>
    </DropdownMenuCheckboxItem>
  );
}

function RichCheckboxItem({
  checked,
  disabled,
  onCheckedChange,
  label,
  description,
  docsUrl,
}: {
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (v: boolean) => void;
  label: string;
  description: string;
  docsUrl?: string | null;
}) {
  const { t } = useLingui();
  return (
    <DropdownMenuCheckboxItem
      checked={checked}
      disabled={disabled}
      onCheckedChange={onCheckedChange}
      className="items-start py-2"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-1">
          <span className="text-xs font-medium">{label}</span>
          {docsUrl && (
            <a
              href={docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="ms-auto text-muted-foreground hover:text-foreground"
              onClick={(e) => e.stopPropagation()}
              aria-label={t`${label} docs`}
            >
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
        <span className="text-[11px] text-muted-foreground">{description}</span>
      </div>
    </DropdownMenuCheckboxItem>
  );
}
