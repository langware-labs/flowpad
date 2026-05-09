import { AlertOctagon } from "lucide-react";

import { Markdown } from "./Markdown";
import type { FeedbackArtifact } from "./types";

interface FeedbackPanelProps {
  feedback?: FeedbackArtifact;
}

export function FeedbackPanel({ feedback }: FeedbackPanelProps) {
  if (!feedback || !feedback.content.trim()) {
    return (
      <div
        className="mx-auto max-w-3xl px-6 py-12 text-center"
        data-testid="workflow-feedback-panel"
      >
        <div className="text-sm font-medium text-foreground">
          No feedback yet
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          The learning agent hasn't surrendered. When it can't fix issues
          through memory updates alone, it will write an actionable report
          here for you.
        </div>
      </div>
    );
  }

  return (
    <div
      className="mx-auto max-w-3xl px-6 py-6"
      data-testid="workflow-feedback-panel"
    >
      <div className="rounded-md border border-amber-300 bg-amber-50 p-4 dark:border-amber-900/60 dark:bg-amber-950/30">
        <div className="flex items-start gap-3">
          <AlertOctagon className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-amber-900 dark:text-amber-100">
              This workflow needs your attention
            </div>
            <div className="mt-0.5 text-xs text-amber-900/70 dark:text-amber-200/70">
              The learning agent has tried multiple iterations and can't
              improve further without a change to the workflow itself.
            </div>
          </div>
        </div>
      </div>
      <Markdown
        text={feedback.content}
        className="prose prose-sm mt-5 max-w-none dark:prose-invert"
      />
    </div>
  );
}
