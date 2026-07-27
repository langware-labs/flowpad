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

// Live-session messages retire the per-message CTA: approval is session-scoped
// (the host approves the SESSION once, from the group header / session view),
// so a prompt carrying a session id never renders "Approve & run".
const approveVisible = (ctx: AttachmentActionContext): boolean =>
  ctx.isFromOther &&
  !ctx.fm.remote_worker_session_id &&
  firstUnapprovedPromptIdx(ctx.fm) >= 0 &&
  !!ctx.handlers.approveAndExecute;

/** Trim a session label so the chip stays "alive candy" (small pill), not a
 *  paragraph. See feedback_chip_design. */
function truncateLabel(label: string, max = 24): string {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

export const ATTACHMENT_ACTION_DESCRIPTORS: AttachmentActionDescriptor[] = [
  {
    key: 'prompt',
    visible: approveVisible,
    build: (ctx) => {
      // No session yet → "Run". A session exists → "<Host>'s session · new run",
      // signalling the prompt joins the already-running session.
      const sessionLabel = ctx.workerSessionExists ? ctx.workerSessionLabel : null;
      return {
        id: 'prompt.approve-execute',
        label: sessionLabel ? `${truncateLabel(sessionLabel)} · new run` : 'Run',
        icon: Play,
        variant: 'primary',
        pulse: ctx.workerSessionInFlight,
        title: sessionLabel
          ? `Approve and run this prompt in ${sessionLabel}`
          : 'Approve this prompt and run it',
        testId: 'message-bubble-execute-prompt',
        run: () => ctx.handlers.approveAndExecute?.(firstUnapprovedPromptIdx(ctx.fm)),
      };
    },
  },
  {
    key: 'spec',
    visible: (ctx) => ctx.isFromOther && !!ctx.specOrPlanTypeId && !!ctx.handlers.viewPlan,
    build: (ctx) => ({
      id: 'spec.view-plan',
      label: 'View Plan',
      icon: Eye,
      variant: 'view',
      title: 'Open the spec/plan in the Milkdown editor',
      testId: 'message-bubble-view-plan',
      run: () => ctx.handlers.viewPlan?.(ctx.specOrPlanTypeId!.id),
    }),
  },
  {
    key: 'spec',
    visible: (ctx) => ctx.isFromOther && !!ctx.specOrPlanTypeId && ctx.hasPlanSession && !!ctx.handlers.openPlanSession,
    build: (ctx) => ({
      id: 'spec.open-spec-session',
      label: 'Open Spec Session',
      icon: ExternalLink,
      variant: 'link',
      title: 'Open the worker session already started for this spec/plan in this conversation',
      testId: 'message-bubble-open-spec-session',
      run: () => ctx.handlers.openPlanSession?.(),
    }),
  },
  {
    key: 'spec',
    visible: (ctx) => ctx.isFromOther && !!ctx.specOrPlanTypeId && !ctx.hasPlanSession && !!ctx.handlers.implementPlan,
    build: (ctx) => ({
      id: 'spec.open-spec',
      label: 'Open Spec',
      icon: Play,
      variant: 'primary',
      title: 'Start a worker session pre-loaded with this spec/plan and the conversation context to read and review (no changes yet)',
      testId: 'message-bubble-open-spec',
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
