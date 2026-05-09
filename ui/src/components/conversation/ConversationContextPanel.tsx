import { ExternalLink } from 'lucide-react';
import { AgenticProcess, Conversation, dataManager, FlowMessage, Task, TypeId } from '@sdk';
import { AttachmentType, type Attachment } from '@sdk/entities/flow-message';
import { ClaudeIcon } from '@src/components/icons/ClaudeIcon';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ContextEntityChip } from './EntityChip';
import { AttachmentChip } from './AttachmentChip';
import { fileAttachmentUrl } from './attachment-url';
import { OpenInClaudeButton } from './OpenInClaudeButton';

interface ConversationContextPanelProps {
  /** The selected message — falls back to the most recent in ConversationView. */
  flowMessage: FlowMessage | null;
  task: Task | null;
  /** Conversation entity — its `contextEntities` (e.g. project) also surface here. */
  conversation: Conversation | null;
  conversationId: string;
  /** Wraps any action that needs a `cwd`/project. */
  ensureMapped?: (continuation: () => void | Promise<void>) => void;
}

const TRANSCRIPT_FILENAME = 'conversation.jsonl';

function isTranscriptAttachment(a: Attachment): boolean {
  return a.attachment_type === AttachmentType.FILE && a.data.endsWith(TRANSCRIPT_FILENAME);
}

/**
 * Body of the conversation drawer's "Context" tab. Surfaces every
 * chip-worthy affordance for the conversation in one place — the toolbar
 * is intentionally empty above us.
 *
 * Sections, top to bottom:
 *   - Open in Claude (resumes / spawns the task's `my_process_id`)
 *   - Open Shared Terminal (the task's `shared_process_id`, when set)
 *   - Entities — merged TypeIds from task / conversation / selected message
 *     `contextEntities` (project, spec, plan, …); de-duped, with self-refs
 *     and the host conversation's own TypeId filtered out.
 *   - Files / Prompts / Transcript — scoped to the selected message.
 */
export function ConversationContextPanel({
  flowMessage,
  task,
  conversation,
  conversationId,
  ensureMapped,
}: ConversationContextPanelProps) {
  const { navigation } = useDockNavigation();

  const messageId = flowMessage?.id ?? '';
  const attachments: Attachment[] = flowMessage?.attachment ?? [];
  const fileAttachments = attachments.filter(
    (a) => a.attachment_type === AttachmentType.FILE && !isTranscriptAttachment(a),
  );
  const promptAttachments = attachments.filter((a) => a.attachment_type === AttachmentType.PROMPT);
  const transcriptAttachment = attachments.find(isTranscriptAttachment);

  // Merge contextEntities from task + conversation + selected message into a
  // single de-duplicated chip row. The task's row contributes project / spec /
  // plan / assignee chips that used to live in the toolbar; the conversation
  // row contributes its own project projection on hub-direct conversations.
  const skipKeys = new Set<string>();
  if (messageId) skipKeys.add(new TypeId(FlowMessage.type, messageId).toString());
  skipKeys.add(new TypeId(Conversation.type, conversationId).toString());
  // Skip the task's own self-ref — we render its dedicated affordances above.
  if (task?.id) skipKeys.add(new TypeId(Task.type, task.id).toString());
  // Suppress AgenticProcess chips for my_process_id / shared_process_id —
  // those have dedicated buttons (Open in Claude / Open Shared Terminal).
  if (task?.my_process_id) skipKeys.add(new TypeId(AgenticProcess.type, task.my_process_id).toString());
  if (task?.shared_process_id) skipKeys.add(new TypeId(AgenticProcess.type, task.shared_process_id).toString());

  const sources: TypeId[][] = [];
  if (task?.contextEntities) sources.push(task.contextEntities);
  if (conversation?.contextEntities) sources.push(conversation.contextEntities);
  if (flowMessage?.contextEntities) sources.push(flowMessage.contextEntities);

  const seen = new Set<string>();
  const contextEntities: TypeId[] = [];
  for (const list of sources) {
    for (const t of list) {
      const key = t.toString();
      if (skipKeys.has(key) || seen.has(key)) continue;
      seen.add(key);
      contextEntities.push(t);
    }
  }

  const conversationContainer = { type: Conversation.type, id: conversationId };

  const handleOpenShared = async () => {
    const sharedId = task?.shared_process_id;
    if (!sharedId) return;
    const proc = await dataManager
      .getByTypeId<AgenticProcess>(new TypeId(AgenticProcess.type, sharedId))
      .catch(() => null);
    if (!proc) return;
    navigation.openDock(proc.dockPointer);
  };

  const showOpenInClaude = !!task;
  const showOpenShared = !!task?.shared_process_id;
  const hasMessageScopedSections =
    !!flowMessage &&
    (fileAttachments.length > 0 ||
      promptAttachments.length > 0 ||
      !!transcriptAttachment);
  const hasAnything =
    showOpenInClaude || showOpenShared || contextEntities.length > 0 || hasMessageScopedSections;

  return (
    <div className="h-full overflow-y-auto p-3 space-y-4" data-testid="conversation-context-panel">
      {showOpenInClaude && (
        <Section title="Open in Claude">
          <OpenInClaudeButton
            task={task!}
            conversationId={conversationId}
            ensureMapped={ensureMapped}
            variant="inline"
          />
        </Section>
      )}

      {showOpenShared && (
        <Section title="Shared Terminal">
          <button
            type="button"
            onClick={() => void handleOpenShared()}
            title="Open the shared terminal where approved prompts run"
            className="inline-flex items-center gap-1.5 rounded-full border border-orange-500/40 bg-orange-500/10 px-2.5 py-1 text-[11px] font-medium text-orange-700 transition-colors hover:bg-orange-500/20 dark:text-orange-300"
          >
            <ClaudeIcon className="h-3.5 w-3.5" />
            Open Shared Terminal
          </button>
        </Section>
      )}

      {contextEntities.length > 0 && (
        <Section title="Entities">
          <div className="flex flex-wrap gap-1">
            {contextEntities.map((typeId) => (
              <ContextEntityChip
                key={typeId.toString()}
                typeId={typeId}
                inside={conversationContainer}
              />
            ))}
          </div>
        </Section>
      )}

      {fileAttachments.length > 0 && (
        <Section title="Files">
          <div className="space-y-1.5">
            {fileAttachments.map((a) => {
              const name = a.data.split('/').pop() ?? a.data;
              return (
                <AttachmentChip
                  key={a.data}
                  url={fileAttachmentUrl(messageId, a.data)}
                  filename={name}
                />
              );
            })}
          </div>
        </Section>
      )}

      {promptAttachments.length > 0 && (
        <Section title="Prompts">
          <div className="space-y-1.5">
            {promptAttachments.map((a, i) => (
              <div
                key={`${a.data}-${i}`}
                className="rounded border border-border bg-muted/30 px-2.5 py-1.5 text-[11px] text-foreground/80"
              >
                {a.data.startsWith('prompt/') ? (
                  <span className="text-muted-foreground">📎 {a.data.slice('prompt/'.length)}</span>
                ) : (
                  <span className="whitespace-pre-wrap break-words">{a.data}</span>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}

      {transcriptAttachment && (
        <Section title="Transcript">
          <a
            href={fileAttachmentUrl(messageId, transcriptAttachment.data)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded border border-border px-2 py-1 text-[11px] text-foreground transition-colors hover:bg-muted"
            title="Open conversation.jsonl in a new tab"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            View transcript
          </a>
        </Section>
      )}

      {!hasAnything && (
        <div className="px-1 py-2 text-[11px] italic text-muted-foreground/70">
          No context yet.
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      {children}
    </div>
  );
}
