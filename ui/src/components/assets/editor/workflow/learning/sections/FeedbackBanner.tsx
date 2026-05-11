import { MarkdownView } from '@src/components/markdown-view';
import { cn } from '@src/lib/utils';
import { AlertOctagon, ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';

interface FeedbackBannerProps {
  feedback: string | null;
  stickyTop?: number;
}

/**
 * Amber banner — only renders when feedback.md is present (the learning agent
 * surrendered). Sticks just below the run header so the user can't miss it.
 */
export function FeedbackBanner({ feedback, stickyTop = 0 }: FeedbackBannerProps) {
  const [open, setOpen] = useState(true);
  if (!feedback?.trim()) return null;
  return (
    <div
      className={cn(
        'z-30 border-b border-amber-300 bg-amber-50 dark:border-amber-900/60 dark:bg-amber-950/30',
      )}
      style={{ position: 'sticky', top: stickyTop }}
      data-testid="learning-feedback-banner"
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-4 py-2 text-left text-xs text-amber-900 transition-colors hover:bg-amber-100/40 dark:text-amber-100 dark:hover:bg-amber-900/30"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <AlertOctagon className="h-3.5 w-3.5" />
        <span className="font-medium uppercase tracking-wide">Needs attention</span>
        <span className="ml-1 normal-case opacity-80">— learner surrendered, workflow needs human change</span>
      </button>
      {open && (
        <div className="border-t border-amber-200/60 px-4 py-3 dark:border-amber-900/40">
          <div className="prose prose-sm max-w-none text-amber-950 dark:prose-invert dark:text-amber-100">
            <MarkdownView value={feedback} compact />
          </div>
        </div>
      )}
    </div>
  );
}
