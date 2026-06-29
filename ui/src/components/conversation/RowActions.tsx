import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import type { ActionSpec } from './conversation-category';

/** Hover-revealed action strip for a conversation row. Renders the descriptor
 *  list from `actionsFor` — icon buttons (with tooltip) and the primary Accept
 *  button — in one place, replacing the inline role-branched JSX. The wrapping
 *  div stops click propagation so action clicks don't open the row. */
export function RowActions({ specs }: { specs: ActionSpec[] }) {
  return (
    <div
      className="absolute right-2 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100"
      onClick={(e) => e.stopPropagation()}
    >
      {specs.map((s) =>
        s.kind === 'primary' ? (
          <button
            key={s.key}
            type="button"
            onClick={s.onClick}
            disabled={s.disabled}
            aria-label={s.label}
            className="rounded bg-primary px-2 py-0.5 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            data-testid={s.testId}
          >
            {s.text}
          </button>
        ) : (
          <Tooltip key={s.key}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={s.onClick}
                disabled={s.disabled}
                aria-label={s.label}
                className={`rounded p-1 ${s.tone === 'destructive' ? 'hover:bg-destructive/10' : 'hover:bg-muted'}`}
                data-testid={s.testId}
              >
                {s.icon && (
                  <s.icon
                    className={`h-3.5 w-3.5 text-muted-foreground ${s.tone === 'destructive' ? 'hover:text-destructive' : ''}`}
                  />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">{s.label}</TooltipContent>
          </Tooltip>
        ),
      )}
    </div>
  );
}
