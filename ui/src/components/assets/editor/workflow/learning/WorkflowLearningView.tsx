import { useToast } from '@src/hooks/use-toast';
import { AgenticProcess, Workflow } from '@sdk';
import { GraduationCap } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { LearningRunDetail } from './LearningRunDetail';
import { LearningRunRow } from './LearningRunRow';
import { runAnalyzer, runLearner } from './runLearningJob';
import { useWorkflowLearningArtifacts } from './useWorkflowLearningArtifacts';

interface WorkflowLearningViewProps {
  workflow: Workflow;
  /** Terminal-status processes for this workflow, newest first. */
  runs: AgenticProcess[];
}

export function WorkflowLearningView({ workflow, runs }: WorkflowLearningViewProps) {
  const { toast } = useToast();
  const [activeId, setActiveId] = useState<string | null>(runs[0]?.id ?? null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [jobByRunner, setJobByRunner] = useState<Record<string, AgenticProcess | undefined>>({});
  const learning = useWorkflowLearningArtifacts(workflow);

  // Keep active selection valid as the run list refreshes.
  useEffect(() => {
    if (!activeId && runs.length > 0) setActiveId(runs[0].id);
    if (activeId && !runs.find((r) => r.id === activeId)) setActiveId(runs[0]?.id ?? null);
  }, [activeId, runs]);

  const activeProcess = useMemo(() => runs.find((r) => r.id === activeId) ?? null, [runs, activeId]);

  const watchJob = useCallback(
    (runnerId: string, job: AgenticProcess) => {
      setJobByRunner((prev) => ({ ...prev, [runnerId]: job }));
      const interval = window.setInterval(() => {
        const status = String(job.status ?? '').toLowerCase();
        if (status === 'stopped' || status === 'failed') {
          window.clearInterval(interval);
          setJobByRunner((prev) => {
            const next = { ...prev };
            delete next[runnerId];
            return next;
          });
          setRefreshKey((k) => k + 1);
          learning.refresh();
        }
      }, 1500);
      return () => window.clearInterval(interval);
    },
    [learning],
  );

  const onAnalyze = useCallback(
    async (runner: AgenticProcess) => {
      try {
        const job = await runAnalyzer({ runner, workflow });
        watchJob(runner.id, job);
        toast({ title: 'Analyzing run…' });
      } catch (err) {
        console.error('[Learning] runAnalyzer failed', err);
        toast({
          title: 'Failed to start analyzer',
          description: err instanceof Error ? err.message : String(err),
          variant: 'destructive',
        });
      }
    },
    [workflow, watchJob, toast],
  );

  const onImprove = useCallback(
    async (runner: AgenticProcess) => {
      try {
        const iteration = (learning.learningLog?.match(/^## /gm)?.length ?? 0) + 1;
        const job = await runLearner({ runner, workflow, iteration });
        watchJob(runner.id, job);
        toast({ title: 'Updating learning…' });
      } catch (err) {
        console.error('[Learning] runLearner failed', err);
        toast({
          title: 'Failed to start learner',
          description: err instanceof Error ? err.message : String(err),
          variant: 'destructive',
        });
      }
    },
    [workflow, watchJob, toast, learning.learningLog],
  );

  if (runs.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
        <div>
          <GraduationCap className="mx-auto h-6 w-6 text-muted-foreground/50" />
          <div className="mt-2">No completed runs yet.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full" data-testid="workflow-learning-view">
      <aside
        className="flex w-72 flex-shrink-0 flex-col border-r"
        data-testid="learning-run-list"
      >
        <header className="flex flex-shrink-0 items-center justify-between border-b px-3 py-2">
          <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <GraduationCap className="h-3.5 w-3.5" />
            Past runs · {runs.length}
          </div>
        </header>
        <div className="flex-1 overflow-y-auto p-1.5">
          {runs.map((p) => (
            <LearningRunRow
              key={p.id}
              process={p}
              isActive={p.id === activeId}
              isJobRunning={!!jobByRunner[p.id]}
              learningLog={learning.learningLog}
              refreshKey={refreshKey}
              onSelect={() => setActiveId(p.id)}
              onAnalyze={() => onAnalyze(p)}
              onImprove={() => onImprove(p)}
            />
          ))}
        </div>
      </aside>
      <main className="min-w-0 flex-1">
        {activeProcess ? (
          <LearningRunDetail
            workflow={workflow}
            process={activeProcess}
            memory={learning.memory}
            feedback={learning.feedback}
            learningLog={learning.learningLog}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Select a run from the list.
          </div>
        )}
      </main>
    </div>
  );
}
