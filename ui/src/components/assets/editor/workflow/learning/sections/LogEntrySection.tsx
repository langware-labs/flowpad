import { MarkdownView } from '@src/components/markdown-view';

import { CollapsibleSection } from './CollapsibleSection';

/**
 * Pulls the entry block(s) referencing the given process id out of learning.log.md.
 * Falls back to "no entry" message when missing.
 */
function extractEntriesForProcess(log: string, processId: string): string[] {
  const blocks = log.split(/^## /m).filter((b) => b.trim());
  return blocks
    .filter((b) => b.includes(processId))
    .map((b) => `## ${b.trimEnd()}`);
}

export function LogEntrySection({
  learningLog,
  processId,
}: {
  learningLog: string | null;
  processId: string;
}) {
  if (!learningLog) {
    return (
      <CollapsibleSection title="Learning log entry" defaultOpen={false} testId="learning-log-section">
        <div className="text-xs text-muted-foreground">
          No <code>learning.log.md</code> yet for this workflow.
        </div>
      </CollapsibleSection>
    );
  }
  const entries = extractEntriesForProcess(learningLog, processId);
  if (entries.length === 0) {
    return (
      <CollapsibleSection title="Learning log entry" defaultOpen={false} testId="learning-log-section">
        <div className="text-xs text-muted-foreground">
          This run is not yet referenced in the learning log. Click <strong>Improve</strong> to record an entry.
        </div>
      </CollapsibleSection>
    );
  }
  return (
    <CollapsibleSection title="Learning log entry" hint={`${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`} testId="learning-log-section">
      <div className="prose prose-sm max-w-none dark:prose-invert">
        <MarkdownView value={entries.join('\n\n')} compact />
      </div>
    </CollapsibleSection>
  );
}
