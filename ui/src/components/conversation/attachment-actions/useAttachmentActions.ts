import { useMemo } from 'react';
import type { FlowMessage, TypeId } from '@sdk';
import type { Attachment } from '@sdk/entities/flow-message';
import { flowMessageSpecOrPlanTypeId } from '../flow-message-helpers';
import { ATTACHMENT_ACTION_DESCRIPTORS } from './registry';
import { flowMessagePromptEntityTypeId, promptAttachmentsOf } from './prompt-attachment';
import type { AttachmentAction, AttachmentActionContext, AttachmentActionHandlers } from './types';

export interface UseAttachmentActionsArgs {
  /** null/undefined in the composer preview (no FlowMessage exists yet). */
  fm: FlowMessage | null | undefined;
  messageId?: string;
  /** Sender-perspective gate, computed by the bubble (roster/local-user aware). */
  isFromOther: boolean;
  handlers: AttachmentActionHandlers;
  isComposerPreview?: boolean;
  hasPlanSession?: boolean;
  /** Whether the conversation already has a worker session (→ "new run" chip). */
  workerSessionExists?: boolean;
  workerSessionLabel?: string | null;
  workerSessionInFlight?: boolean;
}

export interface UseAttachmentActionsResult {
  /** Visible, bound actions in render order. */
  actions: AttachmentAction[];
  /** Every prompt attachment (legacy + entity-backed) — feeds the preview. */
  promptAttachments: Attachment[];
  /** First prompt-entity TypeId, or null — feeds the preview's entity fetch. */
  promptEntityTypeId: TypeId | null;
}

/**
 * Builds the attachment-action context for one message and runs the registry.
 * Descriptors stay declarative; everything hook-shaped (memoization, handler
 * injection) lives here.
 */
export function useAttachmentActions({
  fm,
  messageId,
  isFromOther,
  handlers,
  isComposerPreview = false,
  hasPlanSession = false,
  workerSessionExists = false,
  workerSessionLabel = null,
  workerSessionInFlight = false,
}: UseAttachmentActionsArgs): UseAttachmentActionsResult {
  return useMemo(() => {
    const resolvedFm = fm ?? null;
    const ctx: AttachmentActionContext = {
      fm: resolvedFm,
      messageId,
      isFromOther,
      isComposerPreview,
      specOrPlanTypeId: flowMessageSpecOrPlanTypeId(resolvedFm),
      promptEntityTypeId: flowMessagePromptEntityTypeId(resolvedFm),
      hasPlanSession,
      workerSessionExists,
      workerSessionLabel,
      workerSessionInFlight,
      handlers,
    };
    const actions = ATTACHMENT_ACTION_DESCRIPTORS.filter((d) => d.visible(ctx)).map((d) => d.build(ctx));
    return {
      actions,
      promptAttachments: promptAttachmentsOf(resolvedFm),
      promptEntityTypeId: ctx.promptEntityTypeId,
    };
    // handlers is rebuilt per render by the bubble — memo on its fields' identities
    // would be noise; the bubble's own memoization keeps this cheap enough.
  }, [fm, messageId, isFromOther, isComposerPreview, hasPlanSession, workerSessionExists, workerSessionLabel, workerSessionInFlight, handlers]);
}
