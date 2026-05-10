import type { Workflow } from '@sdk';
import { useEffect, useState } from 'react';

import { workflowDataDirRef } from './runLearningJob';

export interface WorkflowLearningArtifacts {
  memory: string | null;
  feedback: string | null;
  learningLog: string | null;
  isLoading: boolean;
  refresh: () => void;
}

export function useWorkflowLearningArtifacts(workflow: Workflow | null): WorkflowLearningArtifacts {
  const [memory, setMemory] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [learningLog, setLearningLog] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!workflow) {
      setMemory(null);
      setFeedback(null);
      setLearningLog(null);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    const dd = workflowDataDirRef(workflow);
    const readOpt = async (name: string): Promise<string | null> => {
      try {
        return await dd.child(name).read();
      } catch {
        return null;
      }
    };
    void Promise.all([
      readOpt('memory.md'),
      readOpt('feedback.md'),
      readOpt('learning.log.md'),
    ]).then(([m, fb, lg]) => {
      if (cancelled) return;
      setMemory(m);
      setFeedback(fb);
      setLearningLog(lg);
      setIsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [workflow, tick]);

  return {
    memory,
    feedback,
    learningLog,
    isLoading,
    refresh: () => setTick((t) => t + 1),
  };
}
