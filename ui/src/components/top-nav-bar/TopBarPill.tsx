import type { ReactNode } from 'react';

interface TopBarPillProps {
  testId: string;
  icon: ReactNode;
  label: string;
  title: string;
  onClick: () => void;
}

/** A filled pill in the top bar for app status the user can act on (an update is ready, the page is stale). */
export function TopBarPill({ testId, icon, label, title, onClick }: TopBarPillProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      title={title}
      className="flex h-7 shrink-0 items-center gap-1 rounded-full bg-primary px-2 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
