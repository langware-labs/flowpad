/**
 * One ordering, one chip shape. `tabRowItem` maps a backend `TabRow` (the single
 * render source) → a `TabStripItem` for EVERY tab kind — terminal (shell /
 * agentic_process) and content (markdown / asset / settings / search / diff / …).
 * The terminal-vs-content split is gone: a chip is keyed by its `pointer`
 * (== DockPointer.tabHash), so the strip is homogeneous and the active chip is
 * just `currentDock.tabHash`.
 *
 * Display data is backend-resolved on the row (`name`, `icon_key`, `worktree`,
 * `status`/`is_disabled`); the only client-side overlay is the pending-glow,
 * keyed by the process id.
 */
import { AgenticProcess, Shell, type TabRow } from '@sdk';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { type TabStripItem } from '@src/components/tabs/TabStrip';
import { lucideByName } from '@src/lib/lucide-by-name';
import { usePendingSessionIds } from '@src/store/pending-actions-store';
import { LazyProcessTooltip, PROVIDER_META } from '@src/tabs/useTerminalStripController';
import { ViewType, VIEWER_REGISTRY } from '@src/types/ViewType';
import { FileText, FolderGit2 } from 'lucide-react';
import React, { useMemo } from 'react';

const TERMINAL_TARGET_TYPES = new Set<string>([Shell.type, AgenticProcess.type]);
const TAB_LABEL_MAX = 30;

function clip(name: string): string {
  return name.length > TAB_LABEL_MAX ? name.slice(0, TAB_LABEL_MAX).trimEnd() + '…' : name;
}

/** The viewType segment of a Tab.pointer (`viewType|sub`). */
function viewTypeOf(pointer: string): string {
  const i = pointer.indexOf('|');
  return i >= 0 ? pointer.slice(0, i) : pointer;
}

/** TabRow → chip. `isPending` is the only caller-supplied overlay (glow). */
export function tabRowItem(row: TabRow, isPending: boolean): TabStripItem {
  const key = row.pointer || row.id;
  const label = clip(row.name ?? '');

  if (TERMINAL_TARGET_TYPES.has(row.target_type ?? '')) {
    const kind = (
      row.icon_key && row.icon_key in PROVIDER_META ? row.icon_key : 'shell'
    ) as keyof typeof PROVIDER_META;
    const meta = PROVIDER_META[kind];
    const Icon = meta.Icon;
    const processId = row.target_type === AgenticProcess.type ? row.target_id : null;
    return {
      key,
      title: label || meta.label,
      icon: (
        <Icon
          className={`h-3.5 w-3.5 shrink-0 ${meta.iconClassName}`}
          data-provider={kind}
          aria-label={meta.label}
        />
      ),
      badge: row.worktree ? <FolderGit2 className="h-3 w-3 shrink-0 text-amber-500" /> : undefined,
      isDisabled: row.is_disabled,
      statusReason: row.is_disabled ? 'Closing...' : '',
      isPending,
      renameable: true,
      tooltip: processId ? (
        <LazyProcessTooltip
          processId={processId}
          fallbackName={label || meta.label}
          statusReason={row.is_disabled ? 'Closing...' : undefined}
        />
      ) : undefined,
      testId: `tab-${key}`,
      dataAttributes: { 'data-indicator-key': key },
    };
  }

  // Content tab: per-type icon from the backend TypeInfo registry when the dock
  // has a target entity (CLAUDE.md icon rule), else the viewType registry glyph.
  const viewType = viewTypeOf(row.pointer ?? '');
  const meta = VIEWER_REGISTRY[viewType as ViewType];
  if (row.target_type && row.target_id) {
    const Icon = iconForType(row.target_type);
    return {
      key,
      title: label || meta?.title || viewType,
      icon: (
        <Icon
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
          aria-label={`${row.target_type} tab`}
        />
      ),
      renameable: true,
      testId: `tab-content-${key}`,
      dataAttributes: { 'data-tab-kind': row.target_type },
    };
  }
  const Icon = (meta?.iconName && lucideByName(meta.iconName)) || FileText;
  return {
    key,
    title: label || meta?.title || viewType,
    icon: <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />,
    renameable: false,
    testId: `tab-content-${key}`,
  };
}

/** Map the ordered rows → chips, overlaying the pending-glow by process id. */
export function useTabStripItems(rows: TabRow[]): TabStripItem[] {
  const pending = usePendingSessionIds();
  return useMemo(
    () => rows.map((r) => tabRowItem(r, r.target_id ? pending.has(r.target_id) : false)),
    [rows, pending],
  );
}
