/**
 * A view nested in an asset editor: the chain reads in the URL path (`…/agent-<id>/child/<section>/<typeid>`),
 * the parent's pointer stays untouched for every reader, and the tab is the parent's.
 */
import { describe, expect, it } from 'vitest';
import { DockPointer } from '@src/navigation/DockPointer';

const AGENT = 'agent-cd5b3e57-6b3c-4cd8-b401-59deb2d713f5';
const MCP = 'mcp-97501da9-2314-4331-adc1-2dac604a9b31';
const PROJECT = 'c82a1115-2f20-52e0-aa2a-4658898b5873';

describe('a nested child view', () => {
  it('chains after the agent in the URL and lifts back to the agent pointer', () => {
    const agent = DockPointer.fromUrl(`/dock/assets/editor/agent/typeid/${AGENT}`);
    const nested = agent.withChild('mcp', MCP);
    expect(nested.toUrl()).toContain(`/dock/assets/editor/agent/typeid/${AGENT}/child/mcp/${MCP}`);
    expect(nested.toUrl()).not.toContain('child_section');

    const back = DockPointer.fromUrl(nested.toUrl());
    expect(back.pointer).toBe(agent.pointer);
    expect(back.child).toEqual({ section: 'mcp', typeId: MCP });
    expect(back.targetTypeId?.toString()).toBe(AGENT);
  });

  it('a deployment opens nested in its agent, with the selected event in the URL', () => {
    const agent = DockPointer.fromUrl(`/dock/assets/editor/agent/typeid/${AGENT}`);
    const DEP = 'deployment-44444444-4444-4444-8444-444444444444';
    const page = agent.withChild('deployment', DEP).withOption('run', 'p-1').withOption('t', '2026-09-23T20:20:44Z');
    const back = DockPointer.fromUrl(page.toUrl());
    expect(page.toUrl()).toContain(`/typeid/${AGENT}/child/deployment/${DEP}`);
    expect(back.child).toEqual({ section: 'deployment', typeId: DEP });
    expect(back.options?.run).toBe('p-1');
    expect(back.options?.t).toBe('2026-09-23T20:20:44Z');
    expect(page.tabHash).toBe(agent.tabHash);
  });

  it('stays in the agent’s tab', () => {
    const agent = DockPointer.fromUrl(`/dock/assets/editor/agent/typeid/${AGENT}`);
    expect(agent.withChild('skill', 'skill-11111111-1111-4111-8111-111111111111').tabHash).toBe(agent.tabHash);
  });

  it('works on the project-rebased agent editor', () => {
    const url = `/dock/project/${PROJECT}/editor/agent/typeid/${AGENT}/child/schedule/trigger-22222222-2222-4222-8222-222222222222`;
    const dock = DockPointer.fromUrl(url);
    expect(dock.pointer).toBe(`${PROJECT}/editor/agent/typeid/${AGENT}`);
    expect(dock.child?.section).toBe('schedule');
    expect(DockPointer.fromUrl(dock.toUrl()).child).toEqual(dock.child);
  });

  it('withoutChild returns to the agent, and a plain pointer has no child', () => {
    const nested = DockPointer.fromUrl(`/dock/assets/editor/agent/typeid/${AGENT}/child/doc/markdown-33333333-3333-4333-8333-333333333333`);
    expect(nested.withoutChild().toUrl()).toBe(DockPointer.fromUrl(`/dock/assets/editor/agent/typeid/${AGENT}`).toUrl());
    expect(DockPointer.fromUrl(`/dock/assets/editor/agent/typeid/${AGENT}`).child).toBeNull();
    // An unknown section is not a chain — the pointer passes through as it was.
    expect(DockPointer.fromUrl(`/dock/assets/editor/agent/typeid/${AGENT}/child/nope/x-1`).child).toBeNull();
  });
});
