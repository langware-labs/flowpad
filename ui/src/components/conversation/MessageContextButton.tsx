import { useMemo } from 'react';
import { useLingui } from '@lingui/react/macro';
import { AgenticProcess, Conversation, FlowMessage, TypeId } from '@sdk';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { useIsAdvanced } from '@src/contexts/view-mode-context';
import { useContextProcess } from '@src/hooks/useContextProcess';

/**
 * Per-message context-process control (advanced mode only) — the first consumer
 * of {@link useContextProcess}. Declares the message's context (the message + its
 * conversation + project) and, on click, RESUMES the last process bound to it or
 * LAUNCHES a new one. Lives at the bottom of the message bubble.
 */
export function MessageContextButton({
  fm,
  projectId,
}: {
  fm: FlowMessage;
  projectId?: string | null;
}) {
  const { t } = useLingui();
  const isAdvanced = useIsAdvanced();

  const target = fm.id ? new TypeId(FlowMessage.type, fm.id).toString() : null;
  // The message is the identity entity; conversation + project widen the context.
  const contextTypeids = useMemo(() => {
    const ids: string[] = [];
    if (target) ids.push(target);
    if (fm.conversation_id) ids.push(new TypeId(Conversation.type, fm.conversation_id).toString());
    if (projectId) ids.push(new TypeId('project', projectId).toString());
    return ids;
  }, [target, fm.conversation_id, projectId]);

  const { existing, busy, openOrLaunch } = useContextProcess({
    target,
    contextTypeids,
    projectId,
    name: fm.id ? `Message ${fm.id.slice(0, 8)}` : undefined,
    enabled: isAdvanced,  // don't run the resume lookup unless the control is shown
  });

  if (!isAdvanced || !fm.id) return null;
  const Icon = iconForType(AgenticProcess.type);

  return (
    <button
      type="button"
      onClick={openOrLaunch}
      disabled={busy}
      title={existing ? t`Resume the context process for this message` : t`Start a context process for this message`}
      className="mt-1.5 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
    >
      <Icon className="h-3 w-3" />
      {existing ? t`Resume context` : t`Context process`}
    </button>
  );
}
