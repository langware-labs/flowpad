import { describe, expect, it } from 'vitest';
import { Conversation, FlowMessage, Task, TypeId } from '@sdk';
import { buildContextEntityLines, buildConversationStatusPrompt, buildMessageStartPrompt } from '@src/components/conversation/prompt-building';

describe('buildConversationStatusPrompt', () => {
  it('asks the worker to read THIS conversation and report its latest status', () => {
    const tid = new TypeId(Conversation.type, 'ffad88f5-8b96-4171-bf44-c9f0fb698999');
    const prompt = buildConversationStatusPrompt(tid);
    expect(prompt).toContain(`read the Flowpad conversation ${tid.toUrlString()}`);
    expect(prompt).toContain('latest status');
  });

  it('hands the worker the CLI command, never the pointer-only records folder', () => {
    const tid = new TypeId(Conversation.type, 'ffad88f5-8b96-4171-bf44-c9f0fb698999');
    const prompt = buildConversationStatusPrompt(tid);
    expect(prompt).toContain(`flow conversation show ${tid.toUrlString()}`);
    expect(prompt).toContain('flow conversation message');
    expect(prompt).not.toContain('records/conversation');
  });
});

describe('buildMessageStartPrompt', () => {
  it('starts the worker AT the message: reads it by id first, the conversation as background', () => {
    const conv = new TypeId(Conversation.type, 'ffad88f5-8b96-4171-bf44-c9f0fb698999');
    const msg = new TypeId(FlowMessage.type, '0b6c7a8e-1d2f-4e3a-9b8c-7d6e5f4a3b2c');
    const prompt = buildMessageStartPrompt(conv, msg);
    expect(prompt).toContain(`flow conversation message ${msg.toUrlString()}`);
    expect(prompt).toContain(`flow conversation show ${conv.toUrlString()}`);
    expect(prompt.indexOf('flow conversation message')).toBeLessThan(prompt.indexOf('flow conversation show'));
  });
});

describe('buildContextEntityLines', () => {
  it('references a conversation by its read command', () => {
    const tid = new TypeId(Conversation.type, 'ffad88f5-8b96-4171-bf44-c9f0fb698999');
    const [line] = buildContextEntityLines([tid]);
    expect(line).toContain(`read: \`flow conversation show ${tid.toUrlString()}`);
    expect(line).not.toContain('records/');
  });

  it('keeps folder-backed entities on their records path or bare TypeId', () => {
    const tid = new TypeId(Task.type, '0b6c7a8e-1d2f-4e3a-9b8c-7d6e5f4a3b2c');
    const [line] = buildContextEntityLines([tid]);
    expect(line).toContain(tid.toUrlString());
    expect(line).not.toContain('flow conversation');
  });
});
