import type { Crumb } from '@src/components/top-nav-bar/use-entity-breadcrumbs';
import { cn } from '@src/lib/utils';
import { useLingui } from '@lingui/react/macro';

/**
 * The context a Flowpad Assistant chat belongs to, as read-only chips: the
 * project, then what the page shows. Read-only by design — a chat's context is
 * the page it was started on; a different page is a different chat.
 */
export function AssistantContextChips({ crumbs, className }: { crumbs: Crumb[]; className?: string }) {
  const { t } = useLingui();
  if (!crumbs.length) return null;
  return (
    <div
      className={cn('flex min-w-0 flex-wrap items-center gap-1', className)}
      aria-label={t`Chat context`}
      data-testid="assistant-context-chips"
    >
      {crumbs.map(({ key, label, Icon, kind }) => (
        <span
          key={key}
          title={label}
          data-testid="assistant-context-chip"
          data-kind={kind}
          className={cn(
            'inline-flex max-w-[14rem] items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] leading-4',
            kind === 'current' ? 'border-primary/30 bg-primary/10 text-foreground' : 'bg-muted/60 text-muted-foreground',
          )}
        >
          <Icon className="h-3 w-3 flex-shrink-0" aria-hidden />
          <span className="truncate">{label}</span>
        </span>
      ))}
    </div>
  );
}
