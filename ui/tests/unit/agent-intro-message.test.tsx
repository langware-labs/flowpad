import '@testing-library/jest-dom/vitest';

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Agent } from '@sdk';
import { AgentIntroMessage } from '@src/components/agents/AgentIntroMessage';

vi.mock('@src/components/agents/AgentIntroCard', () => ({
  AgentIntroCard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@src/components/agents/AgentAvatar', () => ({
  AgentAvatar: () => <span data-testid="avatar" />,
}));
vi.mock('@src/contexts/view-mode-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@src/contexts/view-mode-context')>();
  return { ...actual, useViewMode: () => mocks.mode };
});
const mocks = vi.hoisted(() => ({ mode: 'vibe' as string }));

describe('AgentIntroMessage', () => {
  it('renders nothing without an agent or without an intro', () => {
    const { container } = render(<AgentIntroMessage agent={null} />);
    expect(container).toBeEmptyDOMElement();
    const blank = render(<AgentIntroMessage agent={new Agent({ name: 'g', intro: '   ' })} />);
    expect(blank.container).toBeEmptyDOMElement();
  });

  it('hides the intro on the terminal surface (Advanced/Dev)', () => {
    mocks.mode = 'advanced';
    const { container } = render(<AgentIntroMessage agent={new Agent({ name: 'g', intro: 'Hi' })} />);
    expect(container).toBeEmptyDOMElement();
    mocks.mode = 'vibe';
  });

  it('renders the intro as an assistant row signed by the agent', () => {
    render(<AgentIntroMessage agent={new Agent({ name: 'greeter', title: 'Greeter', intro: 'Hi **there**' })} />);
    const row = screen.getByTestId('agent-intro-message');
    expect(row).toHaveAttribute('data-role', 'assistant');
    expect(row).toHaveTextContent('Greeter');
    expect(row).toHaveTextContent('Hi there');
    expect(row.querySelector('strong')).toHaveTextContent('there');
  });
});
