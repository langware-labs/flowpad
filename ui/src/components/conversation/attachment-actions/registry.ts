import { t } from '@lingui/core/macro';
import { ExternalLink, Eye, Play } from 'lucide-react';
import type { AttachmentActionContext, AttachmentActionDescriptor } from './types';

/**
 * The attachment-action registry: every CTA a conversation message can carry,
 * declared per attachment family; array order = render order.
 *
 * A prompt attachment carries NO per-message CTA: every prompt is a live
 * session, and consent lives on the session card under the opening message.
 *
 * Adding a new attachment-action pair = appending a descriptor here — no
 * MessageBubble surgery.
 */

export const ATTACHMENT_ACTION_DESCRIPTORS: AttachmentActionDescriptor[] = [
  {
    key: 'spec',
    visible: (ctx) => ctx.isFromOther && !!ctx.specOrPlanTypeId && !!ctx.handlers.viewPlan,
    build: (ctx) => ({
      id: 'spec.view-plan',
      label: t`View Plan`,
      icon: Eye,
      variant: 'view',
      title: t`Open the spec/plan in the Milkdown editor`,
      testId: 'message-bubble-view-plan',
      run: () => ctx.handlers.viewPlan?.(ctx.specOrPlanTypeId!.id),
    }),
  },
  {
    key: 'spec',
    visible: (ctx) => ctx.isFromOther && !!ctx.specOrPlanTypeId && ctx.hasPlanSession && !!ctx.handlers.openPlanSession,
    build: (ctx) => ({
      id: 'spec.open-spec-session',
      label: t`Open Spec Session`,
      icon: ExternalLink,
      variant: 'link',
      title: t`Open the worker session already started for this spec/plan in this conversation`,
      testId: 'message-bubble-open-spec-session',
      run: () => ctx.handlers.openPlanSession?.(),
    }),
  },
  {
    key: 'spec',
    visible: (ctx) => ctx.isFromOther && !!ctx.specOrPlanTypeId && !ctx.hasPlanSession && !!ctx.handlers.implementPlan,
    build: (ctx) => ({
      id: 'spec.open-spec',
      label: t`Open Spec`,
      icon: Play,
      variant: 'primary',
      title: t`Start a worker session pre-loaded with this spec/plan and the conversation context to read and review (no changes yet)`,
      testId: 'message-bubble-open-spec',
      run: () => ctx.handlers.implementPlan?.(),
    }),
  },
];
