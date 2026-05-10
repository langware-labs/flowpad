import { MarkdownView } from '@src/components/markdown-view';
import { AlertOctagon } from 'lucide-react';

import { CollapsibleSection } from './CollapsibleSection';

export function FeedbackSection({ feedback }: { feedback: string | null }) {
  if (!feedback?.trim()) return null;
  return (
    <CollapsibleSection
      title="Feedback"
      hint="needs your attention · shared across runs"
      testId="learning-feedback-section"
    >
      <div className="rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-900/60 dark:bg-amber-950/30">
        <div className="flex items-start gap-2">
          <AlertOctagon className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="text-xs text-amber-900 dark:text-amber-100">
            The learning agent surrendered — the workflow itself needs a human change.
          </div>
        </div>
      </div>
      <div className="prose prose-sm mt-3 max-w-none dark:prose-invert">
        <MarkdownView value={feedback} compact />
      </div>
    </CollapsibleSection>
  );
}
