import { ExternalLink, Eye, Pencil, Play } from 'lucide-react';
import type { AttachmentActionContext, AttachmentActionDescriptor } from './types';
import { firstUnapprovedPromptIdx } from './prompt-attachment';

/**
 * The attachment-action registry: every CTA a conversation message can carry,
 * declared per attachment family. Gating is ported 1:1 from the pre-registry
 * MessageBubble/PromptApprovalRow logic; array order = render order.
 *
 * Adding a new attachment-action pair = appending a descriptor here — no
 * MessageBubble surgery.
 */

const approveVisible = (ctx: AttachmentActionContext): boolean =>
  ctx.isFromOther && firstUnapprovedPromptIdx(ctx.fm) >= 0 && !!ctx.handlers.approveAndExecute;

export const ATTACHMENT_ACTION_DESCRIPTORS: AttachmentActionDescriptor[] = [
  {
    key: 'prompt',
    visible: approveVisible,
    build: (ctx) => ({
      id: 'prompt.approve-execute',
      label: 'Execute',
      icon: Play,
      variant: 'primary',
      title: 'Approve this prompt and run it in the shared session',
      testId: 'message-bubble-execute-prompt',
      run: () => ctx.handlers.approveAndExecute?.(firstUnapprovedPromptIdx(ctx.fm)),
    }),
  },
  {
    key: 'spec',
    visible: (ctx) => ctx.isFromOther && !!ctx.specTypeId && !!ctx.handlers.viewPlan,
    build: (ctx) => ({
      id: 'spec.view-plan',
      label: 'View Plan',
      icon: Eye,
      variant: 'view',
      title: 'Open the spec in the Milkdown editor',
      testId: 'message-bubble-view-plan',
      run: () => ctx.handlers.viewPlan?.(ctx.specTypeId!.id),
    }),
  },
  {
    key: 'spec',
    visible: (ctx) => ctx.isFromOther && !!ctx.specTypeId && ctx.hasPlanSession && !!ctx.handlers.openPlanSession,
    build: (ctx) => ({
      id: 'spec.open-plan-session',
      label: 'Open Plan Implementation Session',
      icon: ExternalLink,
      variant: 'link',
      title: 'Open the plan-implementation session already started in this conversation',
      testId: 'message-bubble-open-plan-session',
      run: () => ctx.handlers.openPlanSession?.(),
    }),
  },
  {
    key: 'spec',
    visible: (ctx) => ctx.isFromOther && !!ctx.specTypeId && !ctx.hasPlanSession && !!ctx.handlers.implementPlan,
    build: (ctx) => ({
      id: 'spec.implement-plan',
      label: 'Implement Plan',
      icon: Play,
      variant: 'primary',
      title: 'Start a Claude Code session pre-loaded with this plan and the conversation context',
      testId: 'message-bubble-implement-plan',
      run: () => ctx.handlers.implementPlan?.(),
    }),
  },
  {
    key: 'prompt',
    visible: (ctx) => ctx.isComposerPreview && !!ctx.handlers.edit && !approveVisible(ctx),
    build: (ctx) => ({
      id: 'prompt.edit',
      label: 'Edit',
      icon: Pencil,
      variant: 'edit',
      title: 'Edit the queued prompt',
      run: () => ctx.handlers.edit?.(),
    }),
  },
];
