import { ExternalLink } from 'lucide-react';
import { AgenticProcess, Conversation, FlowMessage, Task, TypeId } from '@sdk';
import { AttachmentType, type Attachment } from '@sdk/entities/flow-message';
import { ContextEntityChip } from './EntityChip';
import { AttachmentChip } from './AttachmentChip';
import { fileAttachmentUrl } from './attachment-url';
import { OpenInClaudeButton } from './OpenInClaudeButton';

interface ConversationContextPanelProps {
  /** The selected message — falls back to the most recent in ConversationView. */
  flowMessage: FlowMessage | null;
  task: Task | null;
  /** Used to surface the conversation-wide project chip on every message. */
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
 * Body of the conversation drawer's "Context" tab. **Per-message**:
 * everything rendered here is sourced from the currently-selected
 * `flowMessage` — clicking another message switches the panel wholesale.
 *
 * The one exception is the **project** chip: once a project is mapped /
 * selected, it applies to the entire conversation, so it shows on every
 * message's Context. Sourced from `task.project_id || conversation.project_id`
 * (both auto-project to a `Project` TypeId in their `contextEntities`).
 *
 * Per-message sources:
 *   - `flowMessage.contextEntities` — TypeIds the sender stamped.
 *   - `flowMessage.attachment` — TYPE_ID entries surface as entity chips;
 *     FILE / PROMPT entries surface in their dedicated sections.
 *
 * The "Open in Claude" button is the other always-shown task-level affordance.
 */
export function ConversationContextPanel({
  flowMessage,
  task,
  conversation,
  conversationId,
  ensureMapped,
}: ConversationContextPanelProps) {
  const messageId = flowMessage?.id ?? '';
  const attachments: Attachment[] = flowMessage?.attachment ?? [];
  const fileAttachments = attachments.filter(
    (a) => a.attachment_type === AttachmentType.FILE && !isTranscriptAttachment(a),
  );
  const promptAttachments = attachments.filter((a) => a.attachment_type === AttachmentType.PROMPT);
  const transcriptAttachment = attachments.find(isTranscriptAttachment);
  const typeIdAttachments = attachments.filter((a) => a.attachment_type === AttachmentType.TYPE_ID);

  // Skip self-references and the things rendered by dedicated buttons —
  // everything else flows through as a generic chip.
  const skipKeys = new Set<string>();
  if (messageId) skipKeys.add(new TypeId(FlowMessage.type, messageId).toString());
  skipKeys.add(new TypeId(Conversation.type, conversationId).toString());
  if (task?.my_process_id) skipKeys.add(new TypeId(AgenticProcess.type, task.my_process_id).toString());
  if (task?.shared_process_id) skipKeys.add(new TypeId(AgenticProcess.type, task.shared_process_id).toString());

  const seen = new Set<string>();
  const contextEntities: TypeId[] = [];
  const pushTypeId = (t: TypeId | null) => {
    if (!t) return;
    const key = t.toString();
    if (skipKeys.has(key) || seen.has(key)) return;
    seen.add(key);
    contextEntities.push(t);
  };
  // Conversation-wide project chip first — applies to every message once a
  // project is mapped / selected for the conversation.
  const projectId = task?.project_id ?? conversation?.project_id ?? null;
  if (projectId) pushTypeId(new TypeId('project', projectId));
  // Per-message contextEntities.
  for (const t of flowMessage?.contextEntities ?? []) pushTypeId(t);
  // TYPE_ID attachments (spec, task, conversation refs the sender stamped).
  for (const a of typeIdAttachments) {
    try {
      pushTypeId(new TypeId(a.data));
    } catch {
      // Malformed TypeId string — skip silently.
    }
  }

  const conversationContainer = { type: Conversation.type, id: conversationId };

  const showOpenInClaude = !!task;
  const hasMessageScopedSections =
    !!flowMessage &&
    (fileAttachments.length > 0 ||
      promptAttachments.length > 0 ||
      !!transcriptAttachment);
  const hasAnything =
    showOpenInClaude || contextEntities.length > 0 || hasMessageScopedSections;

  if (!flowMessage) {
    return (
      <div className="px-3 py-6 text-center text-[11px] text-muted-foreground">
        Select a message to view its context.
      </div>
    );
  }

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
          No context for this message.
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
