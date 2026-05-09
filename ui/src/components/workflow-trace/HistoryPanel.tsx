/**
 * HistoryPanel — table of past run snapshots from execution_log/, plus a
 * collapsed view of learning.log.md beneath. Clicking a row notifies the
 * parent via onSelectArchive(archiveDir) — the parent swaps the Run tab's
 * data source to the archived run (memory/feedback/history stay anchored
 * at the workflow data folder).
 */

import { AlertCircle, AlertTriangle, CheckCircle2, History } from "lucide-react";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@src/components/ui/accordion";
import { cn } from "@src/lib/utils";

import { Markdown } from "./Markdown";
import type { HistoryEntry, LearningLogArtifact } from "./types";

interface HistoryPanelProps {
  history: HistoryEntry[];
  learningLog?: LearningLogArtifact;
  onSelectArchive: (archiveDir: string) => void;
}

function rowToneIcon(entry: HistoryEntry) {
  if (entry.hasError) {
    return { Icon: AlertCircle, color: "text-destructive" };
  }
  if (entry.totalIssues > 0) {
    return { Icon: AlertTriangle, color: "text-amber-500" };
  }
  if (entry.cleanSteps === entry.totalSteps && entry.totalSteps > 0) {
    return { Icon: CheckCircle2, color: "text-emerald-500" };
  }
  // Unknown / analysis missing
  return { Icon: History, color: "text-muted-foreground" };
}

export function HistoryPanel({ history, learningLog, onSelectArchive }: HistoryPanelProps) {
  return (
    <div
      className="mx-auto max-w-3xl space-y-6 px-6 py-6"
      data-testid="workflow-history-panel"
    >
      <div>
        <div className="mb-3 flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
          <History className="h-3.5 w-3.5" />
          Past runs · {history.length}
        </div>

        {history.length === 0 ? (
          <div className="rounded-md border border-dashed bg-muted/20 p-6 text-center text-sm text-muted-foreground">
            No archived runs yet. Each run + analysis cycle adds a snapshot
            here automatically.
          </div>
        ) : (
          <ul className="space-y-1.5" data-testid="workflow-history-list">
            {history.map((entry) => {
              const { Icon, color } = rowToneIcon(entry);
              const summary =
                entry.totalSteps < 0
                  ? "no analysis"
                  : entry.hasError
                  ? `${entry.cleanSteps}/${entry.totalSteps} clean · 1+ failed`
                  : `${entry.cleanSteps}/${entry.totalSteps} clean${
                      entry.totalIssues > 0
                        ? ` · ${entry.totalIssues} issue${entry.totalIssues === 1 ? "" : "s"}`
                        : ""
                    }`;
              return (
                <li key={entry.timestamp}>
                  <button
                    type="button"
                    onClick={() => onSelectArchive(entry.archiveDir)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-md border bg-card px-3 py-2 text-left transition-colors hover:bg-muted/40",
                      entry.isCurrent && "ring-1 ring-primary/40 bg-muted/40",
                    )}
                    data-testid="workflow-history-row"
                    data-archive={entry.archiveDir}
                  >
                    <Icon className={cn("h-4 w-4 shrink-0", color)} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="text-sm font-medium tabular-nums text-foreground">
                          {entry.display}
                        </span>
                        {entry.isCurrent && (
                          <span className="rounded-full bg-primary/10 px-1.5 py-[1px] text-[10px] font-medium uppercase tracking-wide text-primary">
                            current
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {summary}
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {learningLog && learningLog.entryCount > 0 && (
        <div>
          <Accordion type="single" collapsible>
            <AccordionItem value="log" className="rounded-md border bg-card">
              <AccordionTrigger
                className="px-3 py-2 text-xs uppercase tracking-wide text-muted-foreground hover:no-underline"
                data-testid="workflow-learning-log-toggle"
              >
                Learning log · {learningLog.entryCount}{" "}
                {learningLog.entryCount === 1 ? "entry" : "entries"}
              </AccordionTrigger>
              <AccordionContent className="border-t bg-muted/20 px-3 py-3">
                <Markdown
                  text={learningLog.content}
                  stripFrontmatter={false}
                  className="prose prose-sm max-w-none dark:prose-invert"
                />
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>
      )}
    </div>
  );
}
