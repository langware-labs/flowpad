import { isTerminal, type ActivityProgressSpec, type ActivityState } from '@sdk/activity';
import { useEffect, useRef } from 'react';

import { StepList } from '@src/components/ui/step-list';
import { useActivity } from '@src/hooks/useActivity';
import type { Step, StepStatus } from '@src/hooks/use-step-flow';

const STEP_STATUS: Record<ActivityState, StepStatus> = {
  pending: 'idle',
  running: 'loading',
  blocked: 'loading',
  paused: 'idle',
  completed: 'success',
  failed: 'error',
  cancelled: 'error',
  interrupted: 'error',
};

interface DeployProgressProps {
  /** Where the deploy reports — the `activity` of its answer. */
  activity: Pick<ActivityProgressSpec, 'path' | 'subject_entity'>;
  /** Called once, when the run ends: whether it completed, and its last word (a failure's reason). */
  onEnded: (completed: boolean, message: string | null) => void;
}

/**
 * A taken-on cloud deploy, step by step, as its activity reports it. Renders the backend's steps — it
 * decides nothing. The caller must already watch the deploy's agent (`useWatch`): its steps are
 * addressed to that agent, and a step that starts before the watch is a frame this client never gets.
 */
export function DeployProgress({ activity, onEnded }: DeployProgressProps) {
  const { spec } = useActivity(activity.path, activity.subject_entity);
  const ended = useRef(false);

  useEffect(() => {
    if (!spec || !isTerminal(spec) || ended.current) return;
    ended.current = true;
    onEnded(spec.state === 'completed', spec.message ?? null);
  }, [spec, onEnded]);

  const steps: Step[] = (spec?.children ?? []).map((child: ActivityProgressSpec) => ({
    id: child.name,
    label: child.label ?? child.name,
    status: STEP_STATUS[child.state],
    detail: STEP_STATUS[child.state] === 'error' ? (child.message ?? undefined) : undefined,
  }));
  if (steps.length === 0) return null;
  return <StepList steps={steps} testId="deploy-progress" testIdPrefix="deploy-progress" />;
}
