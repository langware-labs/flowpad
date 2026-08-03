import type { Project } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { Check, Loader2, Plus } from 'lucide-react';
import * as React from 'react';

/** How many project chips to show before collapsing the rest into a count. */
const CHIPS_SHOWN = 2;

/**
 * The "Used by" cell — which projects may use this credential, and the place to
 * change that.
 *
 * It is a management surface, not a readout, because attaching used to require
 * switching the header's project picker: you had to BE in a project to grant it
 * access. Here every project is one toggle away, so the credential and its
 * placements are managed in the same glance.
 *
 * Rendered only when the user actually holds the credential — "used by" is
 * meaningless for a grant that does not exist.
 */
export const UsageCell: React.FC<{
  projects: Project[];
  attached: Project[];
  isLoading?: boolean;
  /** False when the fan-out is gated (too many projects) — offer to load it. */
  isEnabled: boolean;
  onEnable: () => void;
  /** Project → attach/detach. Busy is per-project so one toggle spins alone. */
  busyProjectId?: string | null;
  onToggle: (project: Project, nextAttached: boolean) => void;
}> = ({ projects, attached, isLoading, isEnabled, onEnable, busyProjectId, onToggle }) => {
  const { t } = useLingui();

  if (!isEnabled) {
    return (
      <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs" onClick={onEnable}>
        <Trans>Show</Trans>
      </Button>
    );
  }

  if (isLoading && attached.length === 0) {
    return <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />;
  }

  const shown = attached.slice(0, CHIPS_SHOWN);
  const extra = attached.length - shown.length;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex max-w-full flex-wrap items-center gap-1 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-accent"
          data-testid="connection-usage-trigger"
        >
          {attached.length === 0 ? (
            <span className="text-xs text-muted-foreground">
              <Trans>Not used yet</Trans>
            </span>
          ) : (
            <>
              {shown.map((p) => (
                <Badge key={p.id} variant="secondary" className="max-w-[120px] truncate text-[10px]">
                  {p.displayName || p.name}
                </Badge>
              ))}
              {extra > 0 && <span className="text-[10px] text-muted-foreground">+{extra}</span>}
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        {projects.length === 0 ? (
          // The hub's cold-start case. The grant is real and already saved; say
          // so, rather than presenting an empty list that reads like a failure.
          <p className="p-3 text-xs text-muted-foreground">
            <Trans>No projects yet — the connection is saved to your account; attach it when you create one.</Trans>
          </p>
        ) : (
          <div className="max-h-72 overflow-auto py-1" data-testid="connection-usage-list">
            {projects.map((p) => {
              const isAttached = attached.some((a) => a.id === p.id);
              const busy = busyProjectId === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  disabled={busy}
                  onClick={() => onToggle(p, !isAttached)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent disabled:opacity-60"
                  title={isAttached ? t`Remove access` : t`Give this project access`}
                >
                  <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                    {busy ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : isAttached ? (
                      <Check className="h-3.5 w-3.5 text-green-600 dark:text-green-500" />
                    ) : (
                      <Plus className="h-3 w-3 text-muted-foreground" />
                    )}
                  </span>
                  <span className="truncate">{p.displayName || p.name}</span>
                </button>
              );
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
};
