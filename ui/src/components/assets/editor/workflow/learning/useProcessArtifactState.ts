import { AgenticProcess, FSRef } from '@sdk';
import { dataContext } from '@sdk';
import { useEffect, useState } from 'react';

export interface ProcessArtifactState {
  hasTrace: boolean;
  hasAnalysis: boolean;
  mentionedInLog: boolean;
  isLoading: boolean;
}

export function useProcessArtifactState(
  process: AgenticProcess,
  learningLogText: string | null,
  refreshKey: number,
): ProcessArtifactState {
  const [hasTrace, setHasTrace] = useState(false);
  const [hasAnalysis, setHasAnalysis] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const out = process.output_folder;
    if (!out?.path) {
      setHasTrace(false);
      setHasAnalysis(false);
      setIsLoading(false);
      return;
    }
    const computeNodeId = dataContext.computeNodeTypeId;
    if (!computeNodeId) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    const folder = new FSRef(out.path, computeNodeId, 'folder');
    void folder
      .ls()
      .then((items) => {
        if (cancelled) return;
        const names = new Set(items.map((r) => r.path.split('/').pop()));
        setHasTrace(names.has('workflow.trace.jsonl'));
        setHasAnalysis(names.has('workflow.analysis.jsonl'));
        setIsLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setHasTrace(false);
        setHasAnalysis(false);
        setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [process.id, process.status, refreshKey]);

  const mentionedInLog = !!(learningLogText && learningLogText.includes(process.id));

  return { hasTrace, hasAnalysis, mentionedInLog, isLoading };
}
