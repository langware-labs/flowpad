import type { ComponentType } from 'react';
import { useLingui } from '@lingui/react/macro';
import { Folder, FolderKanban, Sparkles, UserRound } from 'lucide-react';
import { cn } from '@src/lib/utils';
import { BOARD_SCOPES, type BoardScope } from './board-scope';

interface AssetScopeTogglesProps {
  /** Assets per scope, before the text filter. A scope at 0 gets no toggle. */
  counts: Readonly<Record<BoardScope, number>>;
  shown: ReadonlySet<BoardScope>;
  onToggle: (scope: BoardScope) => void;
  /** The worker's display name and logo for the `worker` toggle ("Claude"). */
  workerLabel?: string;
  workerIcon?: ComponentType<{ className?: string }>;
}

/**
 * One independent toggle per asset scope, each with its count. Replaces the old
 * "Assistant" chip: the assistant is just another place assets come from.
 */
export function AssetScopeToggles({ counts, shown, onToggle, workerLabel, workerIcon }: AssetScopeTogglesProps) {
  const { t } = useLingui();
  const meta: Record<BoardScope, { label: string; title: string; Icon: ComponentType<{ className?: string }> }> = {
    project: { label: t`Project`, title: t`The project's own assets`, Icon: FolderKanban },
    dirs: { label: t`Dirs`, title: t`Assets in the project's dependencies and folders added to this run`, Icon: Folder },
    user: { label: t`User`, title: t`Your own assets, shared by every project`, Icon: UserRound },
    assistant: { label: t`Assistant`, title: t`The Flowpad Assistant's assets`, Icon: Sparkles },
    worker: {
      label: workerLabel ?? t`Worker`,
      title: t`Assets the worker brings with it (plugins, bundled extras)`,
      Icon: workerIcon ?? Sparkles,
    },
  };
  const present = BOARD_SCOPES.filter((scope) => counts[scope] > 0);
  if (!present.length) return null;

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1" data-testid="asset-scope-toggles">
      {present.map((scope) => {
        const on = shown.has(scope);
        const { label, title, Icon } = meta[scope];
        return (
          <button
            key={scope}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(scope)}
            title={title}
            data-testid={`asset-scope-toggle-${scope}`}
            className={cn(
              'flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium transition-colors',
              on
                ? 'border-primary/50 bg-primary/10 text-primary hover:bg-primary/20'
                : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            <Icon className="h-3 w-3" />
            <span>{label}</span>
            <span className="tabular-nums opacity-70" data-testid={`asset-scope-count-${scope}`}>
              {counts[scope]}
            </span>
          </button>
        );
      })}
    </div>
  );
}
