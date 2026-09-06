import type { LucideIcon } from 'lucide-react';
import type { FlowMessage, TypeId } from '@sdk';

/**
 * Handlers the hosting view (ConversationView → MessageBubble) injects into
 * the registry context. Descriptors never call hooks — they only invoke these.
 */
export interface AttachmentActionHandlers {
  implementPlan?: () => void;
  openPlanSession?: () => void;
  viewPlan?: (specId: string) => void;
}

/** Everything a descriptor's visible()/build() can read. Built once per
 *  message render by `useAttachmentActions`. */
export interface AttachmentActionContext {
  /** null in the composer preview (no FlowMessage exists yet). */
  fm: FlowMessage | null;
  messageId?: string;
  isFromOther: boolean;
  /** Resolved spec OR plan TypeId on this message (spec wins), or null. A
   *  shared plan (the `.claude/plans` plan-mode artifact) rides the same
   *  View / Open Spec / session affordances as a spec, so descriptors read
   *  this one unified field. */
  specOrPlanTypeId: TypeId | null;
  /** First prompt-entity TYPE_ID attachment's TypeId, or null. */
  promptEntityTypeId: TypeId | null;
  /** True when a plan-implementation session already exists for the thread. */
  hasPlanSession: boolean;
  handlers: AttachmentActionHandlers;
}

/** Visual style buckets — class table lives in AttachmentActionsRow. */
export type AttachmentActionVariant = 'primary' | 'view' | 'link';

/** A bound, renderable action (run closes over its context). */
export interface AttachmentAction {
  id: string;
  label: string;
  icon: LucideIcon;
  variant: AttachmentActionVariant;
  title: string;
  testId?: string;
  run: () => void;
}

/** One attachment-action pair: when it shows, and what it renders/does. */
export interface AttachmentActionDescriptor {
  /** Attachment family this belongs to — documentation/testing key. */
  key: string;
  visible: (ctx: AttachmentActionContext) => boolean;
  build: (ctx: AttachmentActionContext) => AttachmentAction;
}
