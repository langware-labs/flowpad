/**
 * A session launched AS an agent shows that agent's avatar on its tab chip; any
 * other session keeps its provider glyph.
 */
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent, Tab } from '@sdk';

const h = vi.hoisted(() => ({ deploymentId: null as string | null, agent: null as unknown }));

vi.mock('@src/hooks/entity-hooks', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useEntity: () => ({ data: { deployment_id: h.deploymentId } }),
}));
vi.mock('@src/hooks/use-launching-agent', () => ({
  useLaunchingAgent: (deploymentId: string | null) => (deploymentId ? h.agent : null),
}));

import { tabItem } from '@src/tabs/tab-row-item';

const PROC = '6f1c2b3a-1111-4111-8111-111111111111';
const chip = () =>
  tabItem(
    new Tab({
      id: '00000000-0000-4000-8000-0000000000aa',
      pointer: JSON.stringify({ viewType: 'shell', pointer: `agentic_process-${PROC}` }),
      target_type: 'agentic_process',
      target_id: PROC,
      icon_key: 'claude',
      name: 'Claude Code tab',
      visible: true,
    } as never),
  );

afterEach(() => {
  h.deploymentId = null;
  h.agent = null;
});

describe('session tab icon', () => {
  it("shows the agent's avatar when the session was launched as an agent", () => {
    h.deploymentId = 'dep-1';
    h.agent = new Agent({ id: '7e1b3386-0f22-4950-87dc-fd754a4a1545', name: 'helper', avatar: '🦊' } as never);
    render(<>{chip().icon}</>);
    expect(screen.getByTestId('tab-agent-avatar')).toBeTruthy();
    expect(document.querySelector('[data-provider]')).toBeNull();
  });

  it('keeps the provider glyph for a plain session', () => {
    render(<>{chip().icon}</>);
    expect(screen.queryByTestId('tab-agent-avatar')).toBeNull();
    expect(document.querySelector('[data-provider="claude"]')).not.toBeNull();
  });
});
