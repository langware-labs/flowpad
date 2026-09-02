import { Layout, ViewType } from '@sdk';
import { describe, expect, it } from 'vitest';
import { AGENT_PARAM, DockPointer } from '@src/navigation/DockPointer';

const AGENT_ID = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '22222222-2222-4222-8222-222222222222';

describe('Agent inbox navigation', () => {
  it('round-trips the exact deep-link and resolves the Agent target', () => {
    const pointer = DockPointer.forAgentInbox(AGENT_ID);
    expect(pointer.toUrl()).toBe(`/dock/agent/${AGENT_ID}/inbox`);

    const rebuilt = DockPointer.fromUrl(pointer.toUrl());
    expect(rebuilt.viewType).toBe(ViewType.AGENT);
    expect(DockPointer.parseAgentPointer(rebuilt.pointer)).toEqual({ agentId: AGENT_ID, view: 'inbox' });
    expect(rebuilt.targetTypeId?.toString()).toBe(`agent-${AGENT_ID}`);
  });

  it('rejects every shape except <agent-id>/inbox', () => {
    expect(DockPointer.parseAgentPointer(`${AGENT_ID}/settings`)).toEqual({ agentId: null, view: null });
    expect(DockPointer.parseAgentPointer(`${AGENT_ID}/inbox/extra`)).toEqual({ agentId: null, view: null });
  });

  it('preserves Agent scope into a conversation and its message/thread URLs', () => {
    const pointer = DockPointer.forConversation(
      CONVERSATION_ID,
      { messageId: AGENT_ID, thread: 'email-thread', agentId: AGENT_ID },
      Layout.DOCK,
    );
    expect(pointer.options?.[AGENT_PARAM]).toBe(AGENT_ID);
    expect(pointer.agentScopeId).toBe(AGENT_ID);
    expect(DockPointer.fromUrl(pointer.toUrl()).agentScopeId).toBe(AGENT_ID);
  });
});
