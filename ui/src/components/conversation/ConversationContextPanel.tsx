import { ExternalLink } from 'lucide-react';
import { Conversation, FlowMessage, TypeId } from '@sdk';
import { AttachmentType, type Attachment } from '@sdk/entities/flow-message';
import type { Task } from '@sdk';
import { ContextEntityChip } from './EntityChip';
import { AttachmentChip } from './AttachmentChip';
import { fileAttachmentUrl } from './attachment-url';
import { OpenInClaudeButton } from './OpenInClaudeButton';

interface ConversationContextPanelProps {
  /** The selected message — falls back to the most recent in ConversationView. */
  flowMessage: FlowMessage | null;
  task: Task | null;
  conversationId: string;
  /** Wraps any action that needs a `cwd`/project. */
  ensureMapped?: (continuation: () => void | Promise<void>) => void;
}

const TRANSCRIPT_FILENAME = 'conversation.jsonl';

function isTranscriptAttachment(a: Attachment): boolean {
  return a.attachment_type === AttachmentType.FILE && a.data.endsWith(TRANSCRIPT_FILENAME);
}

/**
 * Body of the conversation drawer's "Context" tab. Reflects the currently
 * selected message — its entity chips, attachments, transcript, and the
 * "Open in Claude" affordance for the parent task.
 *
 * Sections render only when non-empty so the panel stays compact for
 * minimally-decorated messages.
 */
export function ConversationContextPanel({
  flowMessage,
  task,
  conversationId,
  ensureMapped,
}: ConversationContextPanelProps) {
  if (!flowMessage) {
    return (
      <div className="px-3 py-6 text-center text-[11px] text-muted-foreground">
        Select a message to view its context.
      </div>
    );
  }

  const messageId = flowMessage.id ?? '';
  const attachments: Attachment[] = flowMessage.attachment ?? [];
  const fileAttachments = attachments.filter(
    (a) => a.attachment_type === AttachmentType.FILE && !isTranscriptAttachment(a),
  );
  const promptAttachments = attachments.filter((a) => a.attachment_type === AttachmentType.PROMPT);
  const transcriptAttachment = attachments.find(isTranscriptAttachment);

  // Skip self-references and the conversation we're already viewing — chips
  // for those would be navigation noise.
  const ownTypeIdStr = messageId ? new TypeId(FlowMessage.type, messageId).toString() : '';
  const conversationTypeIdStr = new TypeId(Conversation.type, conversationId).toString();
  const contextEntities: TypeId[] = flowMessage.contextEntities.filter(
    (t) => t.toString() !== ownTypeIdStr && t.toString() !== conversationTypeIdStr,
  );

  const conversationContainer = { type: Conversation.type, id: conversationId };

  return (
    <div className="h-full overflow-y-auto p-3 space-y-4" data-testid="conversation-context-panel">
      {task && (
        <Section title="Open in Claude">
          <OpenInClaudeButton
            task={task}
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

      {!task &&
        contextEntities.length === 0 &&
        fileAttachments.length === 0 &&
        promptAttachments.length === 0 &&
        !transcriptAttachment && (
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
