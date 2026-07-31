import { useCallback, useState } from 'react';
import { Agent, AgenticProcess, Project, ProcessKind, TypeId } from '@sdk';
import { EntityExecutionPanel } from '@src/components/entity-execution-panel';
import { Button } from '@src/components/ui/button';
import { Skeleton } from '@src/components/ui/skeleton';
import { Trans, useLingui } from '@lingui/react/macro';
import { MessageSquare } from 'lucide-react';
import { HelpdeskRequestDialog } from './HelpdeskRequestDialog';
import { useHelpdeskAgent } from './useHelpdeskAgent';

/**
 * The portal's primary action: ask, and get an answer.
 *
 * When the desk's repo ships a support agent this is the standard chat surface
 * (`EntityExecutionPanel`) bound to it. When it doesn't, it degrades to the
 * human ticket — the same shape the backend uses for a desk with no portal.
 *
 * The chat is deliberately the top of the page. Best practice puts search
 * first and escalation below the fold, but a conversational agent collapses
 * those two into one affordance: it answers from the guides AND can hand off.
 */
export function HelpdeskAsk({ project }: { project: Project }) {
  const { t } = useLingui();
  const { agent, ready } = useHelpdeskAgent(project.id);
  const [askOpen, setAskOpen] = useState(false);

  // Runs once, after the process is created and before its first prompt. This
  // is the only moment the persona can be attached — the spec is persisted into
  // `cli_config`, so a session created without it never gets one.
  const bindAgent = useCallback(
    async (proc: AgenticProcess) => {
      if (!agent?.asset_ref) return;
      try {
        await proc.loadEmbeddedAgent(agent.asset_ref);
      } catch (err) {
        // A persona-less session still answers, just genericly — worth a log,
        // not worth blocking the user's question.
        console.error('[HelpdeskAsk] could not bind the support agent', err);
      }
    },
    [agent?.asset_ref],
  );

  // Hold the surface until the agent query settles. Rendering the composer
  // early would let a fast typist create the session before `bindAgent` is
  // wired, and that session is persona-less for good.
  if (!ready) {
    return <Skeleton className="h-[320px] w-full rounded-lg" />;
  }

  if (agent) {
    return (
      <div className="h-[320px] overflow-hidden rounded-lg border border-border bg-card/40">
        <EntityExecutionPanel
          // Target the AGENT, not the project: `project-<id>` is what vibe chat
          // uses (`vibeChatTargetForProject`), and sharing it would braid the
          // help desk's history into the user's vibe sessions.
          target={new TypeId(Agent.type, agent.id).toString()}
          processType={ProcessKind.Chat}
          dense
          defaultProjectId={project.id}
          defaultWorkdir={project.fs_storage_mount_path ?? null}
          onProcessCreated={bindAgent}
          className="h-full"
          emptyStateText={t`Ask anything — I can search the guides and walk you through them.`}
          placeholder={t`What do you need help with?`}
          newSessionLabel={t`Start over`}
          historyLabel={t`Past questions`}
        />
      </div>
    );
  }

  // No bundled agent → the human path, which is always available.
  return (
    <div className="flex flex-col items-start gap-3 rounded-lg border border-border bg-card/40 px-5 py-6">
      <p className="text-sm text-muted-foreground">
        <Trans>Can’t find what you need? Send us a question and a person will get back to you.</Trans>
      </p>
      <Button
        onClick={() => setAskOpen(true)}
        className="gap-1.5 bg-[hsl(var(--brand))] text-[hsl(var(--brand-foreground))] hover:bg-[hsl(var(--brand))]/90"
        data-testid="helpdesk-ask-button"
      >
        <MessageSquare className="h-4 w-4" />
        <Trans>Ask for help</Trans>
      </Button>
      <HelpdeskRequestDialog open={askOpen} onClose={() => setAskOpen(false)} />
    </div>
  );
}
