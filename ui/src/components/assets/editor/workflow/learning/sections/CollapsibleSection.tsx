import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';

interface CollapsibleSectionProps {
  title: string;
  hint?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
  testId?: string;
  rightSlot?: React.ReactNode;
}

export function CollapsibleSection({ title, hint, defaultOpen = true, children, testId, rightSlot }: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-b" data-testid={testId}>
      <header className="flex items-center justify-between px-4 py-2">
        <button
          type="button"
          className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {title}
          {hint && <span className="ml-1 text-[10px] normal-case text-muted-foreground/70">· {hint}</span>}
        </button>
        {rightSlot}
      </header>
      {open && <div className="px-4 pb-4">{children}</div>}
    </section>
  );
}
