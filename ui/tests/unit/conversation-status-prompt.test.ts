import { describe, expect, it } from 'vitest';
import { Conversation, TypeId } from '@sdk';
import { buildConversationStatusPrompt } from '@src/components/conversation/prompt-building';

describe('buildConversationStatusPrompt', () => {
  it('asks the worker to read THIS conversation and report its latest status', () => {
    const tid = new TypeId(Conversation.type, 'ffad88f5-8b96-4171-bf44-c9f0fb698999');
    const prompt = buildConversationStatusPrompt(tid);
    expect(prompt).toContain(`read the Flowpad conversation ${tid.toUrlString()}`);
    expect(prompt).toContain('latest status');
  });
});
