import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FlowMessage, TypeId } from '@sdk';
import { AttachmentType, type Attachment } from '@sdk/entities/flow-message';
import {
  firstUnapprovedPromptIdx,
  isPromptAttachment,
  useAttachmentActions,
} from '@src/components/conversation/attachment-actions';
import type { AttachmentActionHandlers } from '@src/components/conversation/attachment-actions';

const SPEC_ID = 'c3c3c3c3-0000-4000-8000-000000000003';
const PROMPT_ID = 'e5e5e5e5-0000-4000-8000-000000000005';

function fmWith(attachments: Attachment[], extra: Partial<FlowMessage> = {}): FlowMessage {
  return new FlowMessage({ id: 'fm-1', attachment: attachments, ...extra } as Partial<FlowMessage>);
}

const legacyPrompt = (approved = false): Attachment => ({
  attachment_type: AttachmentType.PROMPT,
  data: 'do the thing',
  ...(approved ? { approved_by: 'u2' } : {}),
});

const entityPrompt = (approved = false): Attachment => ({
  attachment_type: AttachmentType.TYPE_ID,
  data: `prompt-${PROMPT_ID}`,
  prompt_preview: 'do the thing',
  ...(approved ? { approved_by: 'u2' } : {}),
});

const specAttachment: Attachment = {
  attachment_type: AttachmentType.TYPE_ID,
  data: `spec-${SPEC_ID}`,
};

function actionsFor(
  fm: FlowMessage | null,
  handlers: AttachmentActionHandlers,
  opts: { isFromOther?: boolean; isComposerPreview?: boolean; hasPlanSession?: boolean } = {},
) {
  const { result } = renderHook(() =>
    useAttachmentActions({
      fm,
      messageId: fm?.id,
      isFromOther: opts.isFromOther ?? true,
      isComposerPreview: opts.isComposerPreview ?? false,
      hasPlanSession: opts.hasPlanSession ?? false,
      handlers,
    }),
  );
  return result.current;
}

describe('prompt-attachment helpers (dual-generation)', () => {
  it('matches legacy PROMPT and entity-backed TYPE_ID prompts alike', () => {
    expect(isPromptAttachment(legacyPrompt())).toBe(true);
    expect(isPromptAttachment(entityPrompt())).toBe(true);
    expect(isPromptAttachment(specAttachment)).toBe(false);
    // 'prompt_template-…' style ids must NOT match the prompt type.
    expect(isPromptAttachment({ attachment_type: AttachmentType.TYPE_ID, data: 'prompt_template-x' })).toBe(false);
  });

  it('firstUnapprovedPromptIdx scans both generations and skips approved', () => {
    expect(firstUnapprovedPromptIdx(fmWith([legacyPrompt(true), entityPrompt()]))).toBe(1);
    expect(firstUnapprovedPromptIdx(fmWith([legacyPrompt(true), entityPrompt(true)]))).toBe(-1);
    expect(firstUnapprovedPromptIdx(null)).toBe(-1);
  });
});

describe('attachment-action registry visibility', () => {
  const fullHandlers: AttachmentActionHandlers = {
    approveAndExecute: vi.fn(),
    implementPlan: vi.fn(),
    openPlanSession: vi.fn(),
    viewPlan: vi.fn(),
    edit: vi.fn(),
  };

  it('unapproved prompt from the other user → Approve & Execute', () => {
    for (const att of [legacyPrompt(), entityPrompt()]) {
      const { actions } = actionsFor(fmWith([att]), fullHandlers);
      expect(actions.map((a) => a.id)).toContain('prompt.approve-execute');
    }
  });

  it('approved prompt / own message / no handler → no approve action', () => {
    expect(actionsFor(fmWith([entityPrompt(true)]), fullHandlers).actions.map((a) => a.id)).not.toContain(
      'prompt.approve-execute',
    );
    expect(actionsFor(fmWith([entityPrompt()]), fullHandlers, { isFromOther: false }).actions).toHaveLength(0);
    expect(actionsFor(fmWith([entityPrompt()]), { viewPlan: vi.fn() }).actions.map((a) => a.id)).not.toContain(
      'prompt.approve-execute',
    );
  });

  it('spec-bearing message from the other user → View + Implement (no session)', () => {
    const { actions } = actionsFor(fmWith([specAttachment]), fullHandlers, { hasPlanSession: false });
    const ids = actions.map((a) => a.id);
    expect(ids).toEqual(['spec.view-plan', 'spec.implement-plan']);
  });

  it('existing plan session swaps Implement for Open', () => {
    const { actions } = actionsFor(fmWith([specAttachment]), fullHandlers, { hasPlanSession: true });
    const ids = actions.map((a) => a.id);
    expect(ids).toEqual(['spec.view-plan', 'spec.open-plan-session']);
  });

  it('prompt + spec on one message renders approve before spec CTAs', () => {
    const { actions } = actionsFor(fmWith([entityPrompt(), specAttachment]), fullHandlers);
    expect(actions.map((a) => a.id)).toEqual(['prompt.approve-execute', 'spec.view-plan', 'spec.implement-plan']);
  });

  it('composer preview → Edit only (tolerates fm == null)', () => {
    const { actions } = actionsFor(null, { edit: vi.fn() }, { isFromOther: false, isComposerPreview: true });
    expect(actions.map((a) => a.id)).toEqual(['prompt.edit']);
  });

  it('run() dispatches the right handler with the right args', () => {
    const approveAndExecute = vi.fn();
    const viewPlan = vi.fn();
    const fm = fmWith([legacyPrompt(true), entityPrompt(), specAttachment]);
    const { actions } = actionsFor(fm, { approveAndExecute, viewPlan });
    actions.find((a) => a.id === 'prompt.approve-execute')!.run();
    expect(approveAndExecute).toHaveBeenCalledWith(1); // first UNapproved prompt
    actions.find((a) => a.id === 'spec.view-plan')!.run();
    expect(viewPlan).toHaveBeenCalledWith(SPEC_ID);
  });

  it('promptEntityTypeId resolves from the entity attachment', () => {
    const { promptEntityTypeId } = actionsFor(fmWith([entityPrompt()]), fullHandlers);
    expect(promptEntityTypeId).toEqual(new TypeId('prompt', PROMPT_ID));
  });
});
