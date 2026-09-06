import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FlowMessage, TypeId } from '@sdk';
import { AttachmentType, type Attachment } from '@sdk/entities/flow-message';
import { isPromptAttachment, useAttachmentActions } from '@src/components/conversation/attachment-actions';
import type { AttachmentActionHandlers } from '@src/components/conversation/attachment-actions';

const SPEC_ID = 'c3c3c3c3-0000-4000-8000-000000000003';
const PLAN_ID = 'd4d4d4d4-0000-4000-8000-000000000004';
const PROMPT_ID = 'e5e5e5e5-0000-4000-8000-000000000005';

function fmWith(attachments: Attachment[], extra: Partial<FlowMessage> = {}): FlowMessage {
  return new FlowMessage({ id: 'fm-1', attachment: attachments, ...extra } as Partial<FlowMessage>);
}

const legacyPrompt = (): Attachment => ({
  attachment_type: AttachmentType.PROMPT,
  data: 'do the thing',
});

const entityPrompt = (): Attachment => ({
  attachment_type: AttachmentType.TYPE_ID,
  data: `prompt-${PROMPT_ID}`,
  prompt_preview: 'do the thing',
});

const specAttachment: Attachment = {
  attachment_type: AttachmentType.TYPE_ID,
  data: `spec-${SPEC_ID}`,
};

// A shared plan-mode artifact (type='plan') rides the SAME affordances as a spec.
const planAttachment: Attachment = {
  attachment_type: AttachmentType.TYPE_ID,
  data: `plan-${PLAN_ID}`,
};

function actionsFor(
  fm: FlowMessage | null,
  handlers: AttachmentActionHandlers,
  opts: {
    isFromOther?: boolean;
    hasPlanSession?: boolean;
  } = {},
) {
  const { result } = renderHook(() =>
    useAttachmentActions({
      fm,
      messageId: fm?.id,
      isFromOther: opts.isFromOther ?? true,
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

});

describe('attachment-action registry visibility', () => {
  const fullHandlers: AttachmentActionHandlers = {
    implementPlan: vi.fn(),
    openPlanSession: vi.fn(),
    viewPlan: vi.fn(),
  };

  it('a prompt carries NO per-message CTA — consent lives on the session card', () => {
    for (const att of [legacyPrompt(), entityPrompt()]) {
      const { actions, promptAttachments } = actionsFor(fmWith([att]), fullHandlers);
      expect(actions).toHaveLength(0);
      expect(promptAttachments).toHaveLength(1); // the preview still renders
    }
    expect(actionsFor(fmWith([entityPrompt()]), fullHandlers, { isFromOther: false }).actions).toHaveLength(0);
  });

  it('spec-bearing message from the other user → View + Open Spec (no session)', () => {
    const { actions } = actionsFor(fmWith([specAttachment]), fullHandlers, { hasPlanSession: false });
    const ids = actions.map((a) => a.id);
    expect(ids).toEqual(['spec.view-plan', 'spec.open-spec']);
  });

  it('PLAN-bearing message rides the SAME affordances as a spec → View + Open Spec', () => {
    const { actions } = actionsFor(fmWith([planAttachment]), fullHandlers, { hasPlanSession: false });
    const ids = actions.map((a) => a.id);
    expect(ids).toEqual(['spec.view-plan', 'spec.open-spec']);
  });

  it('Open Spec label + read-review title (not "Implement")', () => {
    const { actions } = actionsFor(fmWith([planAttachment]), fullHandlers, { hasPlanSession: false });
    const open = actions.find((a) => a.id === 'spec.open-spec')!;
    expect(open.label).toBe('Open Spec');
    expect(open.title.toLowerCase()).not.toContain('implement');
  });

  it('existing session swaps Open Spec for Open Spec Session', () => {
    const { actions } = actionsFor(fmWith([specAttachment]), fullHandlers, { hasPlanSession: true });
    const ids = actions.map((a) => a.id);
    expect(ids).toEqual(['spec.view-plan', 'spec.open-spec-session']);
  });

  it('prompt + spec on one message renders only the spec CTAs', () => {
    const { actions } = actionsFor(fmWith([entityPrompt(), specAttachment]), fullHandlers);
    expect(actions.map((a) => a.id)).toEqual(['spec.view-plan', 'spec.open-spec']);
  });

  it('composer preview tolerates fm == null and renders nothing', () => {
    const { actions } = actionsFor(null, fullHandlers, { isFromOther: false });
    expect(actions).toHaveLength(0);
  });

  it('run() dispatches the right handler with the right args', () => {
    const viewPlan = vi.fn();
    const fm = fmWith([legacyPrompt(), entityPrompt(), specAttachment]);
    const { actions } = actionsFor(fm, { viewPlan });
    actions.find((a) => a.id === 'spec.view-plan')!.run();
    expect(viewPlan).toHaveBeenCalledWith(SPEC_ID);
  });

  it('promptEntityTypeId resolves from the entity attachment', () => {
    const { promptEntityTypeId } = actionsFor(fmWith([entityPrompt()]), fullHandlers);
    expect(promptEntityTypeId).toEqual(new TypeId('prompt', PROMPT_ID));
  });

});
