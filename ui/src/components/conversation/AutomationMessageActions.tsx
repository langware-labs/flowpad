import { useMemo } from 'react';
import { useLingui } from '@lingui/react/macro';
import { MessageSquareText, Zap } from 'lucide-react';
import { AgenticProcess, Conversation, ProcessKind, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { Button } from '@src/components/ui/button';
import { useFlowpadAssistantProject } from '@src/components/floating-chat/useFlowpadAssistantProject';
import { useProcessesForTarget } from '@src/components/entity-execution-panel/hooks/useProcessesForTarget';
import { errorMessage } from '@src/lib/error-message';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications';
import { mostRecentProcess } from '@src/utils/process-recency';

/**
 * Under what an automation answered (the Daily usage summary): Ask about this -- an assistant session with
 * what the message references (its report) as context, re-focused on a second click -- and Open automation,
 * the rule that posted it (the conversation's ``channel_source_id`` names it).
 */
export function AutomationMessageActions({ conversationId, entities }: { conversationId: string; entities: TypeId[] }) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const { project } = useFlowpadAssistantProject();
  const conversationTypeId = useMemo(() => new TypeId(Conversation.type, conversationId), [conversationId]);
  const { data: conversation } = useEntity<Conversation>(conversationTypeId, { enabled: !!conversationId });
  const report = entities[0];
  const target = report?.toString() ?? '';
  const { processes } = useProcessesForTarget(target, { processType: ProcessKind.Analysis });
  const existing = useMemo(() => mostRecentProcess(processes), [processes]);
  const rule = conversation?.channel_source_id ? new TypeId(conversation.channel_source_id) : null;

  const ask = async () => {
    if (existing?.id) return void navigation.openShellProcess(existing.id);
    const workdir = project?.fs_storage_mount_path;
    if (!report || !workdir) return;
    try {
      await AgenticProcess.launch({
        workerType: 'claude_code',
        workdir,
        projectId: project.id,
        launchPrompt: t`This is what my automation "${conversation?.title ?? ''}" reported (${target}, attached as context). Read it, then wait for my questions.`,
        enableAssistant: true,
        sharedContextEntities: [target],
        processType: ProcessKind.Analysis,
        target,
      });
    } catch (e: unknown) {
      notify.error({ title: t`Could not open the session`, message: errorMessage(e, ''), forceToast: true });
    }
  };

  return (
    <div className="mt-1 flex flex-wrap gap-1.5" data-testid="automation-message-actions">
      {report && (
        <Button
          size="sm"
          className="h-7 px-3 text-xs"
          onClick={() => void ask()}
          disabled={!project?.fs_storage_mount_path}
          data-testid="automation-ask"
        >
          <MessageSquareText className="h-3.5 w-3.5" />
          {existing ? t`Back to the session` : t`Ask about this`}
        </Button>
      )}
      {rule && (
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-3 text-xs"
          onClick={() => navigation.openDock(DockPointer.forAutomations({ trigger: rule.id }))}
          data-testid="automation-open"
        >
          <Zap className="h-3.5 w-3.5" />
          {t`Open automation`}
        </Button>
      )}
    </div>
  );
}
