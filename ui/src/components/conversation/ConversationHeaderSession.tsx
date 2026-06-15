import { useCallback } from 'react';
import { Conversation, type Task } from '@sdk';
import { Play } from 'lucide-react';
import { OpenProjectComponent } from '@src/components/open-project-component/open-project-component';
import { workerIcon, workerLabel } from '@src/components/lens-viewer/shared/transcript-features/transcript-utils';
import { LAUNCHABLE_WORKERS } from './conversation-session-constants';
import { buildAssistancePrompt } from './prompt-building';
import { useConversationSession } from './useConversationSession';
import { useProjectMappingGate } from './useProjectMappingGate';

/**
 * Conversation-header affordance for the conversation's owning worker session.
 * Always renders exactly one of two states (never neither):
 *
 *   - a conversationProcess exists → a single **Open** button → its live shell;
 *   - none exists → a **launch toolbar** (claude_code / codex / copilot).
 *
 * Self-contained: it owns its own project-mapping gate + picker dialog, so it
 * can be dropped into the route header (which has no gate of its own). Launch
 * routes through `ensureMapped`, so an unmapped conversation opens the project
 * picker first and the launch continues automatically once a project is chosen.
 * The header prompt is intentionally light — the assistant prompt is
 * informational and the drawer supplies the full context-aware variant.
 */
export function ConversationHeaderSession({
  conversation,
  task,
}: {
  conversation: Conversation | null;
  task?: Task | null;
}) {
  const { ensureMapped, dialogProps } = useProjectMappingGate(task ?? undefined, conversation ?? undefined);
  const buildPrompt = useCallback(() => buildAssistancePrompt([], []), []);
  const { conversationProcess, starting, launch, open } = useConversationSession({
    conversation,
    ensureMapped,
    buildPrompt,
  });

  if (!conversation) return null;

  return (
    <>
      {conversationProcess ? (
        <button
          type="button"
          onClick={open}
          data-testid="conversation-open-session"
          className="inline-flex h-7 items-center gap-1.5 rounded border border-border px-2 text-xs font-medium text-foreground transition-colors hover:bg-muted"
          title="Open the conversation session"
        >
          <Play className="h-3.5 w-3.5 text-orange-500" />
          <span>Open</span>
        </button>
      ) : (
        <div className="inline-flex items-center gap-1" data-testid="conversation-launch-toolbar">
          {LAUNCHABLE_WORKERS.map((worker) => {
            const Icon = workerIcon(worker);
            return (
              <button
                key={worker}
                type="button"
                onClick={() => launch(worker)}
                disabled={starting}
                data-testid={`conversation-launch-${worker}`}
                title={`Start ${workerLabel(worker)}`}
                className="inline-flex h-7 w-7 items-center justify-center rounded border border-border text-foreground transition-colors hover:bg-muted disabled:opacity-50"
              >
                <Icon className="h-3.5 w-3.5" />
              </button>
            );
          })}
        </div>
      )}
      <OpenProjectComponent {...dialogProps} />
    </>
  );
}
