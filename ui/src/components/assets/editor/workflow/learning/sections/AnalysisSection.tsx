import { AgenticProcess, FSRef, dataContext } from '@sdk';
import { AlertTriangle } from 'lucide-react';
import { useEffect, useState } from 'react';

import { CollapsibleSection } from './CollapsibleSection';

interface AnalysisRecord {
  anchor?: string | number;
  status?: string;
  issues?: Array<{ kind?: string; note?: string }>;
}

export function AnalysisSection({ process }: { process: AgenticProcess; }) {
  const [records, setRecords] = useState<AnalysisRecord[] | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const out = process.output_folder;
    const computeNodeId = dataContext.computeNodeTypeId;
    if (!out?.path || !computeNodeId) {
      setMissing(true);
      setRecords([]);
      return;
    }
    const ref = new FSRef(`${out.path}/workflow.analysis.jsonl`, computeNodeId);
    void ref
      .read()
      .then((text) => {
        if (cancelled) return;
        const parsed = text
          .split(/\r?\n/)
          .filter((l) => l.trim())
          .map((l) => {
            try {
              return JSON.parse(l) as AnalysisRecord;
            } catch {
              return null;
            }
          })
          .filter((r): r is AnalysisRecord => !!r);
        setRecords(parsed);
      })
      .catch(() => {
        if (cancelled) return;
        setMissing(true);
        setRecords([]);
      });
    return () => {
      cancelled = true;
    };
  }, [process.id, process.output_folder?.path]);

  if (records === null) {
    return (
      <CollapsibleSection title="Analysis" testId="learning-analysis-section">
        <div className="text-xs text-muted-foreground">Loading…</div>
      </CollapsibleSection>
    );
  }
  if (missing || records.length === 0) {
    return (
      <CollapsibleSection title="Analysis" testId="learning-analysis-section" defaultOpen={false}>
        <div className="text-xs text-muted-foreground">
          No analysis yet. Click <strong>Analyze</strong> on this run to produce <code>workflow.analysis.jsonl</code>.
        </div>
      </CollapsibleSection>
    );
  }

  const totalIssues = records.reduce((acc, r) => acc + (r.issues?.length ?? 0), 0);
  const summary = totalIssues > 0 ? `${totalIssues} issue${totalIssues === 1 ? '' : 's'}` : 'no issues';

  return (
    <CollapsibleSection title="Analysis" hint={summary} testId="learning-analysis-section">
      <div className="space-y-2 text-xs">
        {records.filter((r) => r.issues && r.issues.length > 0).map((r, i) => (
          <div key={i} className="rounded-md border bg-card p-2">
            <div className="font-mono text-[10px] text-muted-foreground">anchor: {String(r.anchor ?? i)}</div>
            <ul className="mt-1 space-y-0.5">
              {(r.issues ?? []).map((issue, j) => (
                <li key={j} className="flex items-start gap-1.5">
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-500" />
                  <span>
                    <span className="font-medium">{issue.kind ?? 'issue'}</span>
                    {issue.note && <span className="text-muted-foreground"> · {issue.note}</span>}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {totalIssues === 0 && <div className="text-muted-foreground">All anchors clean.</div>}
      </div>
    </CollapsibleSection>
  );
}
