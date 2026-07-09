import type { Spec, Task } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { ExpansionRequest } from '@sdk/FlowSync/query';
import { useMarkdownContent } from '@src/hooks/use-markdown-content';

/**
 * A task's plan text. Reads the inner `spec.md` file (the plan is a plain file,
 * not an entity); falls back to a legacy linked Spec entity (git-push
 * collaboration path) when the file isn't present. Shared by SharedTaskView and
 * TaskDetailPanel so the fallback logic lives in one place.
 */
export function useTaskSpecText(task: Task): string {
  const { body: specFileText } = useMarkdownContent(task.specDoc, { autoSave: false });
  const specTypeId = task.firstContextOfType?.('spec') ?? null;
  const { data: spec } = useEntity<Spec>(specFileText ? null : specTypeId, {
    query: new ExpansionRequest({ expand: ['blobs'] }),
  });
  return specFileText || spec?.content || '';
}
