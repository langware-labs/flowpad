import { useCallback, useMemo, useState } from 'react';
import { useEntity } from '@sdk/react/hooks';
import { sendReply } from '@sdk/entities/notifications';
import { createTaskBundle } from '@sdk/entities/flow-message';
import { ActionInfo } from '@sdk/models/ActionInfo';
import { AgenticProcess, Conversation, Task, dataManager, TypeId } from '@sdk';
import type { ConversationParticipant } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation';
import { loadOptionalTranscript } from '@src/components/conversation/transcript-attachment';

export interface ShareOptions {
  recipients: ConversationParticipant[];
  title: string;
  message?: string;
  files?: File[];
  attachTranscript?: boolean;
  senderName?: string | null;
}

export interface ShareResult {
  sent: boolean;
  gitError?: string | null;
  emailError?: string | null;
}

export interface ExportBundleOptions {
  title: string;
  message?: string;
}

export interface ExportBundleResult {
  flowMessageId: string;
  downloadUrl: string;
}

export interface UseEntityShareResult {
  /** Send to recipient + note. For AgenticProcess, lazy-forks before sending so the recipient gets a clean snapshot. */
  share(opts: ShareOptions): Promise<ShareResult>;
  /** Resolve the entity's deep-link URL and write it to the clipboard. */
  copyLink(): Promise<string>;
  /** Package the share into a downloadable .flowmsg bundle. */
  exportBundle(opts: ExportBundleOptions): Promise<ExportBundleResult>;
  /** True once the entity has loaded and is shareable. */
  canShare: boolean;
  /** True iff this typeId resolves to an AgenticProcess; the share() call will fork before send. */
  shouldForkBeforeSend: boolean;
  /** In-flight flag for share/copyLink/exportBundle. */
  isSharing: boolean;
  /** Pre-fill defaults for a share dialog (title from entity name, generic message body). */
  getDefaults(): { title: string; message: string };
}

function resolveEntityTitle(entity: any, fallback: string): string {
  if (!entity) return fallback;
  // AgenticProcess-specific display name: prefer context_data.display_name → name → instruction prefix.
  if (entity instanceof AgenticProcess) {
    const cd = entity.context_data as Record<string, unknown> | undefined;
    const dn = cd && typeof cd.display_name === 'string' ? cd.display_name.trim() : '';
    if (dn) return dn;
    const name = (entity as { name?: string | null }).name;
    if (typeof name === 'string' && name.trim().length > 0) return name.trim();
    if (entity.instruction_content) {
      const trimmed = entity.instruction_content.replace(/<!--.*?-->/g, '').trim();
      if (trimmed.length > 0) return trimmed.substring(0, 30);
    }
    return fallback;
  }
  // Generic entity: try the common shape.
  const anyEntity = entity as { displayName?: string; name?: string | null; title?: string | null };
  return (
    anyEntity.displayName?.trim() ||
    (typeof anyEntity.name === 'string' ? anyEntity.name.trim() : '') ||
    (typeof anyEntity.title === 'string' ? anyEntity.title.trim() : '') ||
    fallback
  );
}

function resolveDockPointer(entity: any) {
  if (!entity) return null;
  // AgenticProcess: prefer the terminal pointer (attach-to-PTY), it's the canonical shareable URL.
  if (entity instanceof AgenticProcess) return entity.terminalDockPointer;
  const anyEntity = entity as { dockPointer?: unknown };
  return (anyEntity.dockPointer as any) ?? null;
}

/**
 * Generic entity share hook. Pass any TypeId; the hook resolves the entity,
 * exposes share/copyLink/exportBundle actions, and decides whether to fork
 * before sending based on the entity type (only AgenticProcess forks today).
 *
 * Dialog open-state is intentionally NOT owned by this hook — callers compose
 * their own UX (toolbar, slash command, context menu).
 */
export function useEntityShare(typeId: TypeId | null): UseEntityShareResult {
  const { data: entity } = useEntity<any>(typeId);
  const { navigation } = useDockNavigation();
  const [isSharing, setIsSharing] = useState(false);

  const shouldForkBeforeSend = useMemo(
    () => typeId?.type === AgenticProcess.type,
    [typeId?.type],
  );

  const canShare = !!entity && !!typeId;

  const getDefaults = useCallback((): { title: string; message: string } => {
    return {
      title: resolveEntityTitle(entity ?? null, 'Session'),
      message: 'Hi,\nI need some help with this session.\nPlease take a look and let me know.\nThanks!',
    };
  }, [entity]);

  const share = useCallback(
    async (opts: ShareOptions): Promise<ShareResult> => {
      if (!typeId) throw new Error('useEntityShare: no typeId');
      const recipientId = opts.recipients[0]?.email?.trim() ?? '';
      if (!recipientId) throw new Error('Recipient required');
      const title = opts.title.trim();
      if (!title) throw new Error('Title required');
      const recipientEmails = opts.recipients
        .map((p) => (p.email || '').trim())
        .filter((email): email is string => !!email && email.includes('@'));
      if (recipientEmails.length === 0) throw new Error('Recipient required');

      setIsSharing(true);
      try {
        // AgenticProcess path: resolve the live entity so we can fork + attach transcript.
        const isProcess = shouldForkBeforeSend;
        const proc = isProcess
          ? await dataManager
              .getByTypeId<AgenticProcess>(new TypeId(AgenticProcess.type, typeId.id))
              .catch(() => null)
          : null;
        const projectPath = (proc as { workdir?: string } | null)?.workdir ?? null;

        // Transcript attach is meaningful only for AgenticProcess.
        let filesToSend = opts.files ?? [];
        if (isProcess) {
          const transcriptResult = await loadOptionalTranscript(filesToSend, {
            attach: opts.attachTranscript !== false,
            proc,
            projectPath: projectPath ?? undefined,
          });
          filesToSend = transcriptResult.files;
        }

        // Pre-fork on send (lazy) so opening + closing the dialog never orphans a fork.
        let forkedProcessId: string | null = null;
        if (proc) {
          try {
            const forked = await proc.fork(false);
            forkedProcessId = forked.id ?? null;
          } catch (forkErr) {
            console.warn('[useEntityShare] pre-fork failed (non-fatal):', forkErr);
          }
        }

        // Conversation transport: mint a Conversation linked to the entity being
        // shared. For AgenticProcess, mint a Task carrying my_process_id /
        // shared_process_id (matches AskForAssistance / Send-Plan flows) so the
        // recipient's "Approve & Execute" reuses the pre-fork. For other entity
        // types, the entity rides as a TYPE_ID attachment on the first message.
        // ``shared_context_entities`` is passed in the constructor — the new
        // shared-context API doesn't expose a FE-side setter (sharing is a
        // backend decision); the constructor lift moves it into the private
        // ``_shared_context_entities_`` slot and ``save()`` ships it on the wire.
        const assetReferences: string[] = [];
        let task: Task | null = null;
        let convSharedContext: string[] = [];

        if (isProcess) {
          task = new Task({
            title,
            status: 'to_do',
            spec_type: 'request',
            sender_name: opts.senderName?.trim() || undefined,
            recipient_email: recipientEmails[0],
            my_process_id: typeId.id,
          });
          task.shared_process_id = forkedProcessId;
          convSharedContext = [`${Task.type}-${task.id}`];
          assetReferences.push(`${Task.type}-${task.id}`);
          await task.save();
        } else {
          // Generic entity share: the shared entity itself rides as context +
          // first-message TYPE_ID attachment.
          convSharedContext = [`${typeId.type}-${typeId.id}`];
          assetReferences.push(`${typeId.type}-${typeId.id}`);
        }

        const conv = new Conversation({
          title,
          participants: opts.recipients,
          shared_context_entities: convSharedContext,
        } as Partial<Conversation>);
        conv.title = title;
        conv.participants = opts.recipients;

        await conv.save();
        await conv.share(recipientEmails);

        await sendReply(
          { conversationId: conv.id },
          (opts.message ?? '').trim(),
          filesToSend.length > 0 ? filesToSend : undefined,
          assetReferences.length > 0 ? { assetReferences } : undefined,
        );

        navigation.openDock(DockPointer.forConversation(conv.id));
        return { sent: true, gitError: null, emailError: null };
      } finally {
        setIsSharing(false);
      }
    },
    [typeId, shouldForkBeforeSend, navigation],
  );

  const copyLink = useCallback(async (): Promise<string> => {
    if (!entity) throw new Error('Entity not loaded');
    const pointer = resolveDockPointer(entity);
    if (!pointer) throw new Error('Entity has no shareable dock pointer');
    const url = navigation.getDockUrl(pointer);
    try {
      await navigator.clipboard.writeText(url);
    } catch (err) {
      // Caller surfaces the URL in a fallback toast.
      console.warn('[useEntityShare] clipboard write failed:', err);
      throw err;
    }
    return url;
  }, [entity, navigation]);

  const exportBundle = useCallback(
    async (opts: ExportBundleOptions): Promise<ExportBundleResult> => {
      const title = opts.title.trim();
      if (!title) throw new Error('Title required');
      setIsSharing(true);
      try {
        const result = await createTaskBundle({
          spec_title: '',
          spec_content: '',
          task_title: title,
          message: (opts.message ?? '').trim() || null,
          team_space_id: null,
        });
        const downloadUrl = new ActionInfo(
          'file-download',
          'flow_message',
          result.flow_message_id,
          'GET',
        ).fullActionUrl;
        return { flowMessageId: result.flow_message_id, downloadUrl };
      } finally {
        setIsSharing(false);
      }
    },
    [],
  );

  return {
    share,
    copyLink,
    exportBundle,
    canShare,
    shouldForkBeforeSend,
    isSharing,
    getDefaults,
  };
}
