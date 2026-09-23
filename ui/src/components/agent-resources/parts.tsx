import type { ReactNode } from 'react';

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-3 py-2 text-xs italic text-muted-foreground">{children}</div>;
}

/** A section header's `+`. Sized not to grow the line it sits on; the label and
 *  caret set that height. */
export function IconButton({
  icon: Icon,
  label,
  onClick,
  testId,
  disabled = false,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  testId: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-5 w-5 disabled:cursor-not-allowed disabled:opacity-40 flex-shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
      title={label}
      aria-label={label}
      data-testid={testId}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}

/**
 * One item in the agent's resources menu: its icon and its full name, highlighted while it is the
 * one open. The whole row opens it; an optional trailing action (delete) shows on hover or focus.
 */
export function ResourceRow({
  icon: Icon,
  label,
  detail,
  selected,
  muted = false,
  onOpen,
  action,
  testId,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  /** A second, quieter line (a schedule's timing). */
  detail?: string;
  selected: boolean;
  /** Shown dimmed and struck through — something switched off. */
  muted?: boolean;
  onOpen: () => void;
  action?: ReactNode;
  testId: string;
}) {
  return (
    <div
      className={
        'group flex items-center gap-1 pe-1 ' + (selected ? 'bg-primary/10 text-foreground' : 'hover:bg-muted/60')
      }
    >
      <button
        type="button"
        onClick={onOpen}
        aria-current={selected || undefined}
        title={detail ? `${label}\n${detail}` : label}
        className="flex min-w-0 flex-1 items-center gap-2 py-1 ps-6 text-start"
        data-testid={testId}
      >
        <Icon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-col">
          <span className={'truncate text-xs' + (muted ? ' text-muted-foreground line-through' : '')}>{label}</span>
          {detail && <span className="truncate text-[11px] text-muted-foreground">{detail}</span>}
        </span>
      </button>
      {action && <div className="flex-shrink-0 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">{action}</div>}
    </div>
  );
}
